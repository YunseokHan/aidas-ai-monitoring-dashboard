# aidas-ai-monitoring-dashboard

[aidas-ai-monitoring](../aidas-ai-monitoring) 대시보드를 **GitHub Pages(정적)** 로
띄우는 레포. 백엔드 없이, 중앙 서버가 주기적으로 publish하는 **정적 스냅샷
(`data/dashboard.json`)** 하나만 읽어서 동일한 화면을 렌더합니다.

```
중앙 서버(ADS-A100)               GitHub                     브라우저
─────────────────                ──────                     ───────
monitoring.db ──publish.py──▶ data/dashboard.json ──git push──▶ Pages 서빙 ──fetch──▶ 대시보드
(5분마다 cron)                                                           (정적, 읽기전용)
```

- 프론트엔드 구성은 라이브 버전과 **완전히 동일** (개요/라이브/세션/차트/알림/설정).
- 데이터 출처만 `/api/*` → `./data/dashboard.json` 으로 교체.
- 알림 *발송* 은 중앙 서버에서 동작(이 페이지는 표시만, 읽기 전용).

---

## 설치 (한 번만)

### 1) 이 레포를 GitHub에 올리고 Pages 켜기
```bash
# 로컬/중앙 어디서든
git init && git add -A && git commit -m "init dashboard"
git remote add origin git@github.com:<USER>/aidas-ai-monitoring-dashboard.git
git push -u origin main
```
GitHub → 레포 **Settings → Pages → Source: `main` / `/ (root)`** → 저장.
→ `https://<USER>.github.io/aidas-ai-monitoring-dashboard/` 에서 열림.
(`.nojekyll` 포함되어 있어 `data/`·`vendor/` 가 그대로 서빙됨)

### 2) 중앙 서버에서 자동 publish 설정
이 레포를 **중앙 서버**(monitoring.db가 있는 곳)에 `aidas-ai-monitoring` 옆에 clone:
```bash
cd ~/Workspace      # aidas-ai-monitoring 과 같은 부모 폴더
git clone git@github.com:<USER>/aidas-ai-monitoring-dashboard.git
cd aidas-ai-monitoring-dashboard
python3 publish.py            # data/dashboard.json 생성 테스트
python3 publish.py --push     # 커밋+푸시까지 (git 자격증명 필요)
```
cron으로 5분마다 자동화:
```cron
*/5 * * * * cd /home/yunseok/Workspace/aidas-ai-monitoring-dashboard && /mnt/data/miniconda3/bin/python3 publish.py --push >> data/publish.log 2>&1
```

#### `.env` (gitignored — 민감 설정/토큰 보관소)
`.env.example` 을 `.env` 로 복사해 채우세요. `.env` 는 `.gitignore` 처리되어 **커밋되지
않습니다.** publish.py가 이 값을 읽어 동작합니다(CLI 플래그가 우선).
```ini
CENTRAL_DIR=../aidas-ai-monitoring
OUT=data/dashboard.json
REDACT=0                 # 1 = 계정 email 마스킹 (public 레포용)
# 비대화식 git push용 (cron). SSH deploy key를 쓰면 비워두세요.
GITHUB_TOKEN=ghp_xxx     # fine-grained PAT, 이 레포 contents:write 만
GIT_REMOTE=https://github.com/USER/aidas-ai-monitoring-dashboard.git
```
→ **자동 push 토큰은 여기(.env)에만** 두면 됩니다. deploy key(SSH)를 쓰면 토큰 없이
`git push` 만으로 동작하므로 `.env` 에 토큰을 안 넣어도 됩니다.

---

## publish.py
중앙 서버에서 실행. 중앙 백엔드를 재사용해 라이브 API와 동일한 데이터를 묶어
`data/dashboard.json` 으로 씁니다.
```bash
python3 publish.py                         # 생성만
python3 publish.py --central /path/to/aidas-ai-monitoring   # 중앙 레포 경로 지정
python3 publish.py --redact                # 계정 email 마스킹 (public repo용)
python3 publish.py --push                  # git add/commit/push
```
- 기본적으로 `../aidas-ai-monitoring` 를 중앙 레포로 가정 (그 안의 `config.json`+DB 사용).
- 스냅샷에는 `server`(api_key) 제거, email 비밀번호 마스킹.

## 갱신 주기 / 신선도
- 데이터는 publish 주기만큼만 신선합니다(예: 5분). 헤더의 **"데이터 기준 … (N분 전)"** 로 확인.
- 페이지의 자동 새로고침은 30초마다 `dashboard.json` 을 다시 받습니다(실제 갱신은 publish 때).
- "라이브 세션"도 스냅샷 시점 기준이라, 최대 publish 간격만큼 지연될 수 있습니다.

## 파일 구조
```
aidas-ai-monitoring-dashboard/
  index.html  style.css  app.js        # 동일 프론트엔드 (정적 데이터 소스)
  vendor/chart.umd.min.js
  data/dashboard.json                   # 스냅샷 (publish.py가 갱신, 커밋됨)
  publish.py                            # 중앙 DB → 스냅샷 생성기 (중앙 서버에서 실행)
  .nojekyll                             # GitHub Pages가 data/ 등 그대로 서빙
```
