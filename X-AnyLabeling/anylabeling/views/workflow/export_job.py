"""Process lifecycle for desktop model conversion."""
import json
import os
from pathlib import Path
import sys
import uuid
from PyQt6 import QtCore
from anylabeling.services.workflow.model_export import options


class ExportJob(QtCore.QObject):
    def __init__(self, controller):
        super().__init__(controller)
        self.controller = controller
        self.process = None
        self.info = {'status': 'idle', 'logs': []}
        self.buffer = ''

    def active(self):
        return bool(self.process and self.process.state() != QtCore.QProcess.ProcessState.NotRunning)

    def start(self, args):
        owner = self.controller
        owner.ensure_switchable()
        if owner.validation_job and owner.validation_job.state() != QtCore.QProcess.ProcessState.NotRunning:
            raise ValueError('验证仍在运行，请先完成或停止。')
        dialog = owner.workflow.view.training_dialog
        if dialog and dialog.export_manager.is_exporting:
            raise ValueError('高级工具仍在导出，请先完成或停止。')
        config = options(args)
        root = owner.project().root
        payload = root / 'exports' / ('request-' + uuid.uuid4().hex + '.json')
        payload.parent.mkdir(parents=True, exist_ok=True)
        payload.write_text(json.dumps({**args, 'root': str(root)}, ensure_ascii=False), encoding='utf-8')
        self.payload = payload
        self.info = {'status': 'starting', 'logs': [], 'project': str(root), 'format': config['format'], 'precision': config['precision']}
        self.buffer = ''
        process = self.process = QtCore.QProcess(self)
        process.setProcessChannelMode(QtCore.QProcess.ProcessChannelMode.MergedChannels)
        process.setWorkingDirectory(str(root))
        environment = QtCore.QProcessEnvironment.systemEnvironment()
        environment.insert('PYTHONIOENCODING', 'utf-8')
        # Export dependencies are checked explicitly; never let Ultralytics install packages silently.
        environment.insert('YOLO_AUTOINSTALL', 'false')
        process.setProcessEnvironment(environment)
        process.readyReadStandardOutput.connect(self.read)
        process.finished.connect(self.finished)
        process.errorOccurred.connect(lambda error: self.fail(process.errorString()) if error == QtCore.QProcess.ProcessError.FailedToStart else None)
        runner = Path(__file__).resolve().parents[2] / 'services' / 'workflow' / 'model_export.py'
        process.start(sys.executable, ['-u', str(runner), str(payload)])
        owner.bridge.publish_state()
        return {'status': 'starting'}

    def fail(self, message):
        self.info['status'] = 'failed'
        self.info['logs'].append(message)
        self.controller.bridge.publish_state()

    def read(self, final=False):
        self.buffer += bytes(self.process.readAllStandardOutput()).decode('utf-8', errors='replace')
        if final and self.buffer and not self.buffer.endswith('\n'):
            self.buffer += '\n'
        while '\n' in self.buffer:
            line, self.buffer = self.buffer.split('\n', 1)
            if line.startswith('EXPORT_RUN:'):
                self.info['run'] = line[len('EXPORT_RUN:'):].strip()
            elif line.startswith('EXPORT_RESULT:'):
                try:
                    record = json.loads(line[len('EXPORT_RESULT:'):])
                    self.info.update(output=record['output'], run=record['run'], bytes=record['bytes'])
                except (ValueError, KeyError):
                    self.info['logs'].append('结果记录无法读取。')
            elif line.strip():
                import re
                line = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', line)
                self.info['logs'].append(line.strip()[-2000:])
        self.info['logs'] = self.info['logs'][-400:]
        if self.info['status'] == 'starting':
            self.info['status'] = 'running'

    def finished(self, code, status):
        self.read(final=True)
        if self.info['status'] != 'stopped':
            self.info['status'] = 'completed' if code == 0 and self.info.get('output') else 'failed'
        if self.info.get('run'):
            directory = Path(self.info['run'])
            try:
                (directory / 'export.log').write_text('\n'.join(self.info['logs']), encoding='utf-8')
                if self.info['status'] == 'stopped':
                    record_path = directory / 'export.json'
                    try:
                        record = json.loads(record_path.read_text(encoding='utf-8'))
                    except (OSError, ValueError):
                        record = {}
                    record['status'] = 'stopped'
                    record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
            except OSError as error:
                self.info['logs'].append('无法保存日志：' + str(error))
        self.payload.unlink(missing_ok=True)
        self.controller.bridge.publish_state()

    def stop(self):
        if not self.active():
            return
        self.info['status'] = 'stopped'
        if os.name == 'nt':
            import subprocess
            subprocess.run(['taskkill', '/PID', str(int(self.process.processId())), '/T', '/F'], capture_output=True, creationflags=0x08000000)
        else:
            self.process.kill()
        self.process.waitForFinished(3000)
        self.controller.bridge.publish_state()
