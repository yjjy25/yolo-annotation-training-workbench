Option Explicit
Dim shell, fso, root, electron
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
electron = root & "\desktop\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(electron) Then
  MsgBox "Runtime missing. See README.md.", 16, "X-AnyLabeling Workbench"
  WScript.Quit 1
End If
shell.CurrentDirectory = root
shell.Run Chr(34) & electron & Chr(34) & " " & Chr(34) & root & "\desktop" & Chr(34), 1, False
