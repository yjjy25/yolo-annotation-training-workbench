from pathlib import Path
from types import SimpleNamespace
import pytest
from PyQt6 import QtCore
from anylabeling.services.workflow.project import Project, write_json, digest, read_json
from anylabeling.services.workflow.artifacts import inventory, archive
from anylabeling.views.workflow.desktop_controller import DesktopController


@pytest.fixture
def project(tmp_path):
    project=Project.create(tmp_path/'项目','artifacts','detect',['object'])
    for name in ['a','b']:
        base=project.root/'runs'/name/'weights';base.mkdir(parents=True)
        (base/'best.pt').write_bytes(b'best-'+name.encode());(base/'last.pt').write_bytes(b'last-'+name.encode())
        (base.parent/'results.csv').write_text('epoch,metric\n1,0.5')
    for name in ['one','two']:
        base=project.root/'validation'/name;base.mkdir(parents=True)
        write_json(base/'metrics.json',{'at':name,'metrics':{'mAP@0.5':.5}})
        (base/'result.webm').write_bytes(b'video-result');(base/'confusion_matrix.png').write_bytes(b'plot')
    (project.root/'models'/'local.pt').write_bytes(b'local-weight')
    write_json(project.root/'models'/'local.workflow.json',{'template':'preserved'})
    return project


def args(project,kind,keys):return {'project_root':str(project.root),'kind':kind,'keys':keys}


def test_archive_validation_preserves_content_and_models(project):
    source=project.root/'validation'/'one';before={p.name:digest(p) for p in source.iterdir()}
    result=archive(project,args(project,'validation',['one','one']))
    assert result['count']==1 and result['keys']==['one'] and not result['failed']
    target=Path(result['archive'])/'validation'/'one'
    assert {p.name:digest(p) for p in target.iterdir()}==before
    assert not source.exists() and (project.root/'validation'/'two').is_dir()
    assert (project.root/'runs'/'a'/'weights'/'best.pt').is_file()
    assert read_json(Path(result['archive'])/'restore.json')['keys']==['one']


def test_archive_model_weights_keeps_logs_and_other_models(project):
    result=archive(project,args(project,'models',['runs/a/weights']))
    assert result['count']==1
    assert not (project.root/'runs'/'a'/'weights').exists()
    assert (project.root/'runs'/'a'/'results.csv').is_file()
    assert (Path(result['archive'])/'runs'/'a'/'weights'/'last.pt').read_bytes()==b'last-a'
    assert {i['key'] for i in inventory(project,'models')}=={'runs/b/weights','models/local.pt'}


def test_archive_imported_weight_keeps_sidecar(project):
    result=archive(project,args(project,'models',['models/local.pt']))
    assert not (project.root/'models'/'local.pt').exists()
    target=Path(result['archive'])/'models'
    assert (target/'local.pt').read_bytes()==b'local-weight'
    assert read_json(target/'local.workflow.json')=={'template':'preserved'}


@pytest.mark.parametrize('keys', [['../outside'],['runs/a'],['runs/a/weights','runs/missing/weights'],['models/local.pt',None],[]])
def test_invalid_request_moves_nothing(project,keys):
    with pytest.raises(ValueError):archive(project,args(project,'models',keys))
    assert (project.root/'runs'/'a'/'weights'/'best.pt').is_file()
    assert not (project.root/'removed').exists()


def test_project_switch_rejected(project):
    payload=args(project,'validation',['one']);payload['project_root']=str(project.root.parent/'other')
    with pytest.raises(ValueError,match='项目已切换'):archive(project,payload)
    assert (project.root/'validation'/'one').exists()


def test_external_link_is_never_archived(project,tmp_path):
    external=tmp_path/'outside.pt';external.write_bytes(b'external')
    link=project.root/'models'/'linked.pt'
    try:link.symlink_to(external)
    except OSError:pytest.skip('Symlink creation unavailable')
    assert 'models/linked.pt' not in {r['key'] for r in inventory(project,'models')}
    with pytest.raises(ValueError):archive(project,args(project,'models',['models/linked.pt']))
    assert external.read_bytes()==b'external'


def test_running_validation_blocks_archive_before_file_operations(project):
    controller=SimpleNamespace(ensure_switchable=lambda:None,validation_job=SimpleNamespace(state=lambda:QtCore.QProcess.ProcessState.Running))
    with pytest.raises(ValueError,match='验证正在运行'):DesktopController.call(controller,'archive_artifacts',args(project,'validation',['one']))
    assert (project.root/'validation'/'one').is_dir()
