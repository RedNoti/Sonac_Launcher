# sonac launcher

Synology NAS 또는 WebDAV 저장소에 로그인해 파일과 런처 바로가기를 여러 PC에서 사용할 수 있는 Windows·macOS 데스크톱 앱입니다.

## 설치

- Windows 64비트 Intel·AMD는 [설치 프로그램](dist/sonac_launcher-0.1.0-win-x64-setup.exe)을 실행합니다. 설치 후 시작 메뉴에서 **sonac launcher**를 실행합니다.
- macOS는 **이 Mac에 관하여**에서 칩을 확인하고 [Apple Silicon](dist/sonac_launcher-0.1.0-mac-arm64.dmg) 또는 [Intel](dist/sonac_launcher-0.1.0-mac-x64.dmg)용 DMG를 엽니다. **sonac launcher**를 **응용 프로그램** 폴더로 드래그합니다.

이 빌드에는 Windows 배포 서명과 Apple 공증이 적용되어 있지 않습니다. macOS 앱은 로컬 테스트용으로 임시 서명했습니다. 운영체제 정책에 따라 첫 실행에 확인이 필요할 수 있습니다.

## 로그인과 파일 전송

1. **Synology NAS**를 선택하고 DSM의 직접 접속 주소를 입력합니다. 예시는 `https://nas.example.com:5001`입니다. NAS에 등록한 DSM 사용자 이름과 비밀번호로 로그인합니다. 인증 앱을 사용 중이면 **2단계 인증 사용**에서 OTP를 입력합니다.
2. 홈 화면에서 **File Station**을 눌러 공유 폴더를 엽니다. **파일 업로드**에서 이 PC의 파일을 선택하거나 파일 행의 **다운로드**를 눌러 저장 위치를 지정합니다.
3. WebDAV 저장소를 쓸 때는 **WebDAV 클라우드**를 선택하고 HTTPS 접속 주소와 계정을 입력합니다. 로그인 후 **클라우드 파일**에서 파일을 전송할 수 있습니다.

Synology 파일 전송은 런처 안에서 File Station API로 처리됩니다. 연결하려면 해당 PC에서 DSM HTTPS 주소에 도달할 수 있어야 하고, DSM 계정에 File Station과 공유 폴더 권한이 있어야 합니다. 업로드에는 쓰기 권한이 필요합니다. 인증서 오류가 표시되면 인증서에 등록된 호스트 이름으로 접속하고 해당 인증서의 발급 체인을 확인합니다. [Synology DSM 로그인 API](https://kb.synology.com/ko-kr/DG/DSM_Login_Web_API_Guide/3) · [File Station API](https://global.download.synology.com/download/Document/Software/DeveloperGuide/Package/FileStation/All/enu/Synology_File_Station_API_Guide.pdf)

## 여러 PC에서 파일 받기

1. 모든 PC에서 같은 저장소와 계정으로 로그인합니다. PC를 재시작한 뒤에도 자동으로 연결하려면 **이 PC에서 로그인 유지**를 선택합니다.
2. 각 PC에서 **백업 · 동기화**를 열고 같은 **클라우드 폴더**와 각 PC에서 사용할 저장 위치를 고릅니다.
3. 자동 확인 간격은 기본 5분입니다. **지금 동기화**로 즉시 확인할 수 있습니다. 자동 동기화가 켜진 상태에서 창을 닫으면 메뉴 막대 또는 알림 영역에 남아 확인을 계속합니다. 앱을 완전히 종료하면 다음 실행과 로그인 후 확인을 재개합니다.
4. **런처 편집**으로 바로가기 URL을 바꾸거나 새 타일을 추가합니다. 동기화 폴더가 연결되어 있으면 저장 시 `sonac-launcher.config.json`을 클라우드에 기록하고, 다른 PC가 다음 확인에서 가져갑니다. 여러 PC에서 동시에 편집하면 서버에 마지막으로 저장된 구성을 사용합니다.

일반 파일은 클라우드에서 이 PC로만 동기화됩니다. 이름이 같은 기존 파일은 보존합니다. 클라우드에 올릴 파일은 앱의 업로드 버튼에서 선택합니다. 하단에는 현재 PC의 마지막 확인 결과가 표시됩니다.

## 소스에서 빌드

Node.js를 설치한 환경에서 `npm ci`를 실행합니다. macOS 패키징은 macOS에서, Windows 패키징은 NSIS의 `makensis`가 설치된 환경에서 실행합니다.

```sh
npm start
npm run check
npm run build:mac -- arm64
npm run build:mac -- x64
npm run build:win
```

설치 파일은 `dist/`에 생성됩니다. 빌드는 Electron 공식 릴리스에서 런타임을 가져오고 SHA-256을 검증합니다. 이미 받은 공식 ZIP 파일을 사용하려면 `SONAC_ELECTRON_ZIP`에 해당 파일 경로를 지정합니다.
