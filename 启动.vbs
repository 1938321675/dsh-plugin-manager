' ===========================================================================
'  DSH Plugin Manager - silent launcher
'
'  Why VBScript instead of .cmd:
'
'    1. Hide the console window
'       Pointing a shortcut at powershell.exe pops up a black console window.
'       WScript.Shell.Run with window style 0 hides it completely.
'
'    2. Immune to cmd code page issues
'       .cmd files are parsed by cmd.exe using the system code page (GBK on
'       a Chinese system). Any non-ASCII byte in the file can corrupt the
'       script and produce bogus "not recognized" errors.
'
'  This file is intentionally ASCII-only for the same reason.
' ===========================================================================

Option Explicit

Dim fso, shell, root, target, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
target = root & "\start.ps1"

If Not fso.FileExists(target) Then
    MsgBox "Cannot find start.ps1 - the program folder is incomplete.", vbCritical, "DSH Plugin Manager"
    WScript.Quit 1
End If

cmd = "powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File """ & target & """"
shell.Run cmd, 1, False
