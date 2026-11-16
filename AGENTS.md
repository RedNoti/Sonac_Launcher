# Sonac Launcher 릴리스 빌드

- 매 빌드 결과를 보고할 때 설치 파일과 함께 **패치 내역**을 표시한다. 직전 릴리스 이후의 커밋과 이번 작업의 변경 사항을 확인하고, 실제 빌드에 포함된 기능 변경과 버그 수정을 사용자 관점에서 짧게 요약한다. 버전만 변경한 빌드라면 그 사실을 적는다.

- 표시 버전은 `package.json`의 `releaseVersion`으로 관리한다. Windows MSI의 `version`은 이전 배포보다 높은 세 부분 숫자로 지정하고 `package-lock.json`의 루트 버전 두 곳과 맞춘다. a0.3.7의 MSI 버전은 0.3.21이다.
- 빌드 전에 기존 배포에 사용한 업데이트 서명 키를 확인한다. 키가 없으면 기존 키를 복구한 뒤 빌드한다. 빌드 스크립트가 새로 만든 키로는 기존 설치본이 업데이트를 검증할 수 없다.
- Windows 업데이트 변경 시 숨김 PowerShell이 별도 설치 도우미를 시작하는지, 런처가 `helper-ready`를 기다린 뒤 종료하는지, 도우미가 MSI 설치 후 `resources\sonac-release.txt`를 확인하고 재실행하는지 점검한다.
- 릴리스마다 `npm run check`와 `node --test test/update-manifest.test.js`를 실행한다. Apple Silicon DMG와 Windows x64 MSI를 만들고, 두 매니페스트의 채널·버전·서명·설치 파일 해시를 확인한다. 알파는 `SONAC_RELEASE_CHANNEL=a npm run build`로 빌드한다.
- Mac에서 MSI를 만드는 과정과 Windows에서 설치 및 자동 재실행을 확인하는 과정을 구분해서 보고한다. 이전 버전의 업데이트 도우미가 실패하면 a0.3.7 MSI를 수동 설치한 뒤, 같은 키로 서명한 상위 버전으로 업데이트를 검증한다. 실패 로그는 `%APPDATA%\sonac launcher\update-logs`에서 확인한다.
