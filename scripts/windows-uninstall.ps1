$ErrorActionPreference = 'Stop'
if (-not [Environment]::UserInteractive -or (Get-Process -Id $PID).SessionId -eq 0) { exit 0 }
Add-Type -AssemblyName System.Windows.Forms
$roaming = [Environment]::GetFolderPath('ApplicationData')
if (-not $roaming) { exit 0 }
$data = Join-Path $roaming 'sonac launcher'
if (-not [IO.Directory]::Exists($data)) { exit 0 }

$title = '소낙 런처 제거'
$question = "이 PC에 저장된 로그인, 설정, AI 대화와 서버 배포 데이터를 삭제할까요?`n`n별도로 지정한 동기화·다운로드 폴더의 파일은 유지됩니다."
$answer = [Windows.Forms.MessageBox]::Show($question, $title, 'YesNo', 'Question', 'Button2')
if ($answer -ne 'Yes') { exit 0 }

try {
  if (Get-Process -Name 'sonac launcher' -ErrorAction SilentlyContinue) {
    throw '런처가 실행 중입니다. 종료한 뒤 아래 폴더를 삭제하세요.'
  }
  if (([IO.File]::GetAttributes($data) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw '설정 폴더가 다른 위치로 연결되어 있습니다. 실제 위치를 확인하세요.'
  }
  [IO.Directory]::Delete($data, $true)
} catch {
  [void][Windows.Forms.MessageBox]::Show("일부 데이터를 지우지 못했습니다.`n`n$data`n`n$($_.Exception.Message)", $title, 'OK', 'Warning')
}
