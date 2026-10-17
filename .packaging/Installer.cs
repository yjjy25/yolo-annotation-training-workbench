using System;
using System.IO;
using System.IO.Compression;
using System.Drawing;
using System.Windows.Forms;
using System.ComponentModel;
using System.Diagnostics;
using System.Reflection;
using System.Text;

// The signed-by-distribution libraries remain unchanged inside a ZIP64 payload.
// Only this installer is an unsigned project build. It needs no administrator rights.
public class Installer : Form {
    TextBox folder=new TextBox(); Button install=new Button(); ProgressBar bar=new ProgressBar();
    Label status=new Label(); CheckBox shortcut=new CheckBox(); BackgroundWorker worker=new BackgroundWorker();
    string installed; bool closingAfterCancel;
    [STAThread] public static int Main(string[] args) {
        try {
            if(args.Length==2 && args[0]=="--extract-only") { Extract(args[1],null);return 0; }
            Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new Installer());return 0;
        } catch(Exception e) { if(args.Length==2) File.WriteAllText(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(args[1])),"extract-error.txt"),e.ToString()); else MessageBox.Show(e.Message,"解压未完成");return 1; }
    }
    public Installer() {
        Text="标注训练工作台 · 离线安装";ClientSize=new Size(620,305);FormBorderStyle=FormBorderStyle.FixedDialog;MaximizeBox=false;StartPosition=FormStartPosition.CenterScreen;
        BackColor=Color.FromArgb(24,27,33);ForeColor=Color.FromArgb(240,242,246);Font=new Font("Microsoft YaHei UI",10);
        var title=new Label(){Text="标注、审查与训练，一次准备完成",Left=25,Top=20,Width=570,Height=34,Font=new Font(Font.FontFamily,16,FontStyle.Bold)};Controls.Add(title);
        Controls.Add(new Label(){Text="离线包包含 Python、Electron 及 CPU/GPU 训练组件。\n仅解压到所选目录；请先保存并关闭正在运行的旧版。",Left=25,Top=65,Width=570,Height=52});
        folder.SetBounds(25,130,477,30);folder.Text=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AnnotationWorkbench","@VERSION@");Controls.Add(folder);
        var browse=new Button(){Text="选择位置",Left=512,Top=128,Width=85,Height=33};browse.Click+=(s,e)=>{if(worker.IsBusy)return;using(var dialog=new FolderBrowserDialog()){dialog.Description="选择工作台文件夹（项目数据会保存在其中）";if(dialog.ShowDialog()==DialogResult.OK)folder.Text=Path.Combine(dialog.SelectedPath,"AnnotationWorkbench-@VERSION@");}};Controls.Add(browse);
        shortcut.Text="创建桌面快捷方式";shortcut.Checked=true;shortcut.SetBounds(25,174,340,28);Controls.Add(shortcut);
        bar.SetBounds(25,214,570,18);Controls.Add(bar);status.SetBounds(25,246,428,43);status.Text="准备好后点击解压并安装。已有项目和系统 Python 不会被删除。";Controls.Add(status);
        install.SetBounds(466,247,129,36);install.Text="解压并安装";install.BackColor=Color.FromArgb(241,179,76);install.ForeColor=Color.FromArgb(33,24,7);install.Click+=Start;Controls.Add(install);
        worker.WorkerReportsProgress=true;worker.WorkerSupportsCancellation=true;worker.DoWork+=(s,e)=>Extract((string)e.Argument,(percent,name)=>{if(worker.CancellationPending)throw new OperationCanceledException();worker.ReportProgress(percent,name);});
        worker.ProgressChanged+=(s,e)=>{bar.Value=Math.Min(100,e.ProgressPercentage);status.Text="正在解压 "+e.ProgressPercentage+"%\n"+(string)e.UserState;};
        worker.RunWorkerCompleted+=(s,e)=>{if(e.Error!=null){install.Enabled=true;folder.Enabled=true;status.Text=e.Error is OperationCanceledException?"解压已停止；已有文件保留，可重新安装。":"解压未完成："+e.Error.Message;if(closingAfterCancel)Close();return;}installed=folder.Text;try{if(shortcut.Checked)Shortcut(installed);}catch{}status.Text="安装完成。点击启动工作台；以后使用桌面入口即可。";install.Text="启动工作台";install.Enabled=true;};
        FormClosing+=(s,e)=>{if(worker.IsBusy){e.Cancel=true;if(!closingAfterCancel&&MessageBox.Show("停止解压并退出？已解压的文件会保留，可重新安装。","正在安装",MessageBoxButtons.YesNo)==DialogResult.Yes){closingAfterCancel=true;worker.CancelAsync();status.Text="正在停止解压…";}}};
    }
    void Start(object sender,EventArgs e) {if(installed!=null){Process.Start(new ProcessStartInfo(Path.Combine(installed,"AnnotationWorkbench.exe")){WorkingDirectory=installed,UseShellExecute=true});Close();return;}try{folder.Text=Path.GetFullPath(folder.Text);}catch(Exception error){MessageBox.Show(error.Message,"请选择有效的安装目录");return;}install.Enabled=false;folder.Enabled=false;worker.RunWorkerAsync(folder.Text);}
    static void Shortcut(string destination) {
        var type=Type.GetTypeFromProgID("WScript.Shell");var shell=Activator.CreateInstance(type);
        var link=type.InvokeMember("CreateShortcut",BindingFlags.InvokeMethod,null,shell,new object[]{Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),"标注训练工作台.lnk")});
        var linkType=link.GetType();linkType.InvokeMember("TargetPath",BindingFlags.SetProperty,null,link,new object[]{Path.Combine(destination,"AnnotationWorkbench.exe")});linkType.InvokeMember("WorkingDirectory",BindingFlags.SetProperty,null,link,new object[]{destination});linkType.InvokeMember("IconLocation",BindingFlags.SetProperty,null,link,new object[]{Path.Combine(destination,"resources","app","icon.ico")+",0"});linkType.InvokeMember("Save",BindingFlags.InvokeMethod,null,link,null);
    }
    static void Extract(string destination,Action<int,string> update) {
        destination=Path.GetFullPath(destination);Directory.CreateDirectory(destination);var prefix=destination.TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar;
        using(var input=File.OpenRead(Assembly.GetExecutingAssembly().Location)) {
            input.Seek(-16,SeekOrigin.End);var reader=new BinaryReader(input,Encoding.UTF8,true);long size=reader.ReadInt64();if(Encoding.ASCII.GetString(reader.ReadBytes(8))!="XALPACK1" || size<1 || size>input.Length-16)throw new Exception("离线包不完整，请核对 SHA256 后重新下载。");
            using(var stream=new SectionStream(input,input.Length-16-size,size))using(var archive=new ZipArchive(stream,ZipArchiveMode.Read)) {
                long total=0,done=0;foreach(var entry in archive.Entries)total+=entry.Length;int last=-1;byte[] buffer=new byte[1024*1024];
                foreach(var entry in archive.Entries) {
                    var target=Path.GetFullPath(Path.Combine(destination,entry.FullName.Replace('/',Path.DirectorySeparatorChar)));if(!target.StartsWith(prefix,StringComparison.OrdinalIgnoreCase))throw new Exception("包内路径无效。");
                    if(entry.FullName.EndsWith("/")){Directory.CreateDirectory(target);continue;}Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using(var source=entry.Open())using(var output=new FileStream(target,FileMode.Create,FileAccess.Write,FileShare.None)) {int count;while((count=source.Read(buffer,0,buffer.Length))>0){output.Write(buffer,0,count);done+=count;int percent=total==0?100:(int)(done*100/total);if(percent!=last){if(update!=null)update(percent,Path.GetFileName(target));last=percent;}}}
                }
            }
        }
    }
    class SectionStream:Stream {
        Stream source;long start,length,position;public SectionStream(Stream stream,long offset,long size){source=stream;start=offset;length=size;position=0;}
        public override bool CanRead{get{return true;}} public override bool CanSeek{get{return true;}}public override bool CanWrite{get{return false;}}public override long Length{get{return length;}}public override long Position{get{return position;}set{Seek(value,SeekOrigin.Begin);}}
        public override int Read(byte[] bytes,int offset,int count){source.Position=start+position;int read=source.Read(bytes,offset,(int)Math.Min(count,length-position));position+=read;return read;}
        public override long Seek(long offset,SeekOrigin origin){long next=origin==SeekOrigin.Begin?offset:origin==SeekOrigin.Current?position+offset:length+offset;if(next<0||next>length)throw new IOException("超出包体范围。");position=next;return next;}
        public override void Flush(){}public override void SetLength(long value){throw new NotSupportedException();}public override void Write(byte[] b,int o,int c){throw new NotSupportedException();}
    }
}
