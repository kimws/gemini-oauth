# gemini-oauth

**Gemini CLI OAuth → 로컬 OpenAI 호환 API**

[English documentation](README.md)

gemini-oauth는 인증된 Gemini CLI / Google Code Assist OAuth 세션을 로컬 프록시로 재사용해, 로컬 클라이언트가 사용할 수 있는 작은 OpenAI 호환 API를 제공하는 비공식 프로젝트입니다. OpenAI Chat Completions API를 사용하는 도구에서 API 키 대신 Google 계정의 Gemini CLI / Code Assist 이용 권한을 사용하고 싶을 때 활용할 수 있습니다.

```
$ gemini-oauth --detach --port 18080

Gemini OAuth proxy started in background
  url: http://127.0.0.1:18080/v1
```

> **비공식 프로젝트입니다.** Google LLC, Gemini, Gemini CLI, Antigravity와 제휴·후원·공식 승인을 받은 프로젝트가 아닙니다. 사용하기 전에 라이선스 및 법적 주의사항을 읽으세요.

## 무엇을 하는 프로젝트인가요?

Gemini CLI는 일반적으로 Google OAuth 세션을 ~/.gemini/oauth_creds.json에 저장합니다. 이 프로젝트는 다음 작업을 수행합니다.

1. 해당 세션 또는 지원되는 macOS Antigravity 키체인 세션을 읽습니다.
2. 만료가 임박한 OAuth access token을 자동으로 갱신합니다.
3. Cloud Code Assist project ID를 자동으로 해석하거나 지정된 값을 사용합니다.
4. OpenAI 형식의 메시지·도구·이미지·생성 옵션을 Code Assist 요청 형식으로 변환합니다.
5. Code Assist 비공개 upstream endpoint를 호출합니다.
6. 응답을 OpenAI Chat Completions 형식 또는 간단한 Responses 형식으로 다시 변환합니다.

프록시는 로컬에서 동작하며 상태를 저장하지 않습니다. 클라이언트가 매 요청에 대화 이력을 포함해야 합니다. 호스팅 서비스·데이터베이스·별도의 GEMINI_API_KEY는 필요하지 않습니다.

### 주요 기능

- PKCE를 사용하는 브라우저 OAuth 로그인과 SSH용 headless/device 방식 로그인
- 이미 로그인된 공식 Gemini CLI 세션 재사용
- access token 자동 갱신 및 upstream 401 발생 시 한 번 재시도
- foreground 실행 또는 status·logs·stop 명령을 지원하는 백그라운드 daemon
- non-streaming 및 SSE streaming을 지원하는 OpenAI 호환 chat/completions
- non-streaming 요청을 위한 간단한 /v1/responses 호환
- 함수/tool-call 변환 및 data URL 이미지 입력 변환
- 모델 allowlist·포트·host·auth 파일·Code Assist project 설정
- 요청 검증 및 기본 10 MiB JSON 요청 본문 크기 제한
- auth store·upstream client·HTTP server를 내장할 수 있는 TypeScript 라이브러리 export

기본 upstream은 https://daily-cloudcode-pa.googleapis.com/v1internal의 Code Assist 비공개 API입니다. 기업용 Code Assist 구독의 경우 프로덕션 엔드포인트(https://cloudcode-pa.googleapis.com/v1internal)를 사용하므로, `--url` CLI 옵션 또는 `CODE_ASSIST_URL` 환경 변수로 설정할 수 있습니다. 공개 Gemini API가 아니며, 이 프로젝트가 안정성이나 지속적인 접근을 보장할 수 있는 endpoint도 아닙니다.

## 사전 요구사항

- Node.js 20 이상
- Gemini CLI / Code Assist를 사용할 수 있는 Google 계정
- 이미 로그인된 공식 Gemini CLI 세션 또는 gemini-oauth login을 통한 로그인
- smoke test에는 curl이 유용하며, 출력 정리용으로 jq·Python은 선택 사항입니다.

공식 Gemini CLI는 이 패키지가 설치하지 않습니다. 먼저 gemini로 로그인하려면 별도로 설치하세요.

## 설치

현재 npm registry에는 게시하지 않았습니다. 소스에서 설치합니다.

```bash
git clone https://github.com/kimws/gemini-oauth.git
cd gemini-oauth
npm ci
```

### CLI 전역 설치

저장소의 전역 설치 스크립트는 TypeScript를 빌드한 뒤 패키지를 설치합니다.

```bash
npm run install:global

# 같은 작업을 직접 실행하는 방법:
npm run build
npm install -g .
```

npm 전역 디렉터리에 쓸 권한이 없다면 사용자 소유 npm prefix를 설정하거나 아래의 로컬 실행 방식을 사용하세요. 프록시 자체에 root 권한은 필요하지 않습니다.

### 로컬 package tarball을 만들어 설치

```bash
npm ci
npm pack
npm install -g ./gemini-oauth-0.1.0.tgz
```

생성되는 파일명에는 package.json의 버전이 들어갑니다.

## 인증

### 기존 Gemini CLI 세션 재사용

공식 Gemini CLI에 이미 로그인되어 있으면 보통 추가 로그인이 필요하지 않습니다.

```bash
gemini-oauth status
gemini-oauth --detach
```

기본 인증 파일은 ~/.gemini/oauth_creds.json입니다.

### 이 CLI로 로그인

브라우저를 사용하는 loopback OAuth 방식:

```bash
gemini-oauth login
```

SSH 또는 headless 환경:

```bash
gemini-oauth login --device
```

브라우저를 자동으로 열지 않고 인증 URL만 출력:

```bash
gemini-oauth login --no-open
```

로그인 과정은 PKCE 기반 OAuth를 사용하고, 결과를 Gemini CLI 호환 파일에 저장한 뒤 Code Assist project를 해석하려고 시도합니다. 프로젝트 자동 해석이 되지 않으면 아래처럼 project를 명시하세요.

macOS에서는 기본적으로 OS keychain에 저장된 Antigravity 세션도 확인합니다. gemini-oauth logout은 이 세션을 삭제하지 않으므로 해당 Antigravity 도구로 별도 관리해야 합니다. 이 프로젝트에서 가장 이식성이 높은 기본 경로는 파일 기반 Gemini CLI 인증입니다.

## 프록시 실행

### Foreground

```bash
npm start
# 또는 빌드 후:
node dist/cli.js --port 18080
```

### 백그라운드 daemon

```bash
gemini-oauth --detach
gemini-oauth --detach --port 18080
```

daemon 관리:

```bash
gemini-oauth status
gemini-oauth logs --follow
gemini-oauth stop
```

기본 base URL은 http://127.0.0.1:10551/v1입니다. 포트를 바꾸면 base URL도 바뀌므로 시작 시 출력되거나 status에 표시되는 URL을 사용하세요.

### CLI 옵션

| 옵션 | 기본값 | 설명 |
| --- | --- | --- |
| --host <host> | 127.0.0.1 | bind 주소. loopback이 아닌 주소는 --allow-remote가 필요합니다. |
| --allow-remote | off | 인증 없는 프록시를 loopback 외부에 노출할 위험을 명시적으로 인정합니다. 이 옵션이 API 인증을 추가하지는 않습니다. |
| --port <port> | 10551 | 수신 포트. GEMINI_OAUTH_PORT로 기본값을 설정할 수도 있습니다. |
| --auth-file <path> | ~/.gemini/oauth_creds.json | Gemini CLI 호환 OAuth 인증 파일 경로입니다. |
| --project <id> | 자동 | Code Assist / GCP project ID를 덮어씁니다. |
| --models <ids> | 내장 allowlist | /v1/models에 반환할 모델 ID를 콤마로 구분합니다. |
| --url <url> | https://daily-cloudcode-pa.googleapis.com/v1internal | Upstream Code Assist 엔드포인트 URL (예: 프로덕션 https://cloudcode-pa.googleapis.com/v1internal). |
| --logging-level <lvl> | info | 로그 레벨: debug, info, warn, error, silent. |
| --detach, -d | off | 백그라운드 daemon으로 시작합니다. |
| --device | off | headless 로그인 방식을 사용합니다. |
| --no-open | off | 로그인 시 브라우저를 자동으로 열지 않고 URL만 출력합니다. |
| --follow, -f | off | logs와 함께 daemon 로그를 계속 출력합니다. |
| --force | off | 의도적으로 다른 포트를 사용할 때 foreground 두 번째 프로세스를 허용합니다. |

### Project 선택 순서

Project는 다음 순서로 결정됩니다.

1. --project
2. GOOGLE_CLOUD_PROJECT 또는 GOOGLE_CLOUD_PROJECT_ID
3. ~/.gemini/gemini-oauth.json에 캐시된 project
4. Code Assist의 loadCodeAssist / onboardUser로 얻은 project

계정에서 사용자 소유 GCP project를 요구하면 시작 전에 설정하세요.

```bash
export GOOGLE_CLOUD_PROJECT=my-gcp-project
gemini-oauth --detach

# 한 번만 적용:
gemini-oauth --project my-gcp-project --detach
```

해당 project는 로그인한 계정과 관련 Google 서비스 정책에서 유효해야 합니다.

## API 호환 범위

| Method | Path | 지원 내용 |
| --- | --- | --- |
| GET | / 또는 /health | 로컬 health 및 기본 실행 정보 |
| GET | /v1/models | 설정된 모델 allowlist. 이 경로에서는 공개 모델 discovery endpoint를 사용하지 않습니다. |
| POST | /v1/chat/completions | OpenAI 형식 chat 요청. streaming 지원 |
| POST | /v1/responses | 간단한 Responses 형식 호환. non-streaming만 지원 |

일반적인 model, messages, stream, temperature, top_p, stop, max_tokens, max_completion_tokens, tools 및 tool-call 메시지를 처리합니다. content 배열은 text와 data URL image_url 블록을 지원합니다. 이는 상호운용성 subset이며 OpenAI API 전체와의 완전한 동등성을 보장하지 않습니다.

중요한 동작:

- /v1/responses에 stream: true를 보내면 400 unsupported_parameter를 반환합니다. SSE streaming은 /v1/chat/completions를 사용하세요.
- /v1/models는 계정의 모든 실시간 모델 목록이 아니라 설정된 allowlist를 반환합니다.
- allowlist에 있는 모델도 계정·tier에서 허용되지 않을 수 있습니다. 실제 사용 가능 여부와 quota는 upstream이 결정합니다.
- 요청 본문은 기본적으로 10 MiB까지 허용됩니다.
- 프록시는 prompt·대화 이력·응답을 저장하지 않습니다. 단, 요청은 upstream Google 서비스로 전달되며 해당 서비스의 약관과 데이터 처리 정책이 적용됩니다.

## 사용 예시

먼저 프록시를 시작하고, 로그인한 계정에서 허용된 모델을 선택하세요.

### curl

```bash
export BASE=http://127.0.0.1:10551/v1

curl -sS "$BASE/models"

curl -sS "$BASE/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Reply with exactly: PONG"}],
    "stream": false
  }'
```

Streaming:

```bash
curl -N -sS "$BASE/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Write a haiku about proxies."}],
    "stream": true
  }'
```

### OpenAI Node SDK

```bash
npm install openai
```

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "gemini-oauth", // 로컬 프록시는 이 값을 검증하지 않습니다.
  baseURL: "http://127.0.0.1:10551/v1",
});

const result = await client.chat.completions.create({
  model: "gemini-2.5-flash",
  messages: [{ role: "user", content: "Hello from Node" }],
});

console.log(result.choices[0]?.message?.content);
```

### OpenAI Python SDK

```bash
python -m pip install openai
```

```python
from openai import OpenAI

client = OpenAI(
    api_key="gemini-oauth",
    base_url="http://127.0.0.1:10551/v1",
)

result = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "Hello from Python"}],
)

print(result.choices[0].message.content)
```

저장소 examples 디렉터리에도 curl.sh, fetch.mjs, openai-sdk.mjs, openai_python.py 예제가 있습니다.

## TypeScript 라이브러리로 사용

```ts
import {
  GeminiAuthStore,
  GeminiUpstream,
  startGeminiOAuthServer,
} from "gemini-oauth";

const auth = new GeminiAuthStore();
const server = await startGeminiOAuthServer({
  auth,
  port: 10551,
});

console.log(server.url);

const upstream = new GeminiUpstream({ auth });
const result = await upstream.chatCompletions({
  model: "gemini-2.5-flash",
  messages: [{ role: "user", content: "Hello" }],
});

console.log(result);
```

auth store·server·upstream client·OAuth login helper·daemon helper·project resolution helper 및 TypeScript 타입을 export합니다. 전체 export 범위는 src/index.ts에서 확인할 수 있습니다.

## 파일 및 인증 정보 관리

| 경로 | 목적 |
| --- | --- |
| ~/.gemini/oauth_creds.json | Gemini CLI 호환 access/refresh token. 지원되는 환경에서 0600 권한으로 작성합니다. |
| ~/.gemini/gemini-oauth.json | 로컬 project ID·계정 email·tier cache |
| ~/.gemini/oauth-proxy/state.json | 분리 daemon 상태 |
| ~/.gemini/oauth-proxy/server.pid | 분리 daemon PID |
| ~/.gemini/oauth-proxy/server.log | 분리 daemon 로그 |

OAuth 인증 정보는 비밀번호처럼 취급하세요. commit·paste·upload·log·공유·재판매하지 마세요. 인증 정보가 노출되었다면 해당 Google 계정의 관련 도구에서 revoke한 뒤 다시 로그인하세요.

gemini-oauth logout은 지정된 파일 기반 인증 정보와 로컬 state를 지웁니다. Antigravity OS keychain 세션은 지우지 않습니다.

## 개발 및 검증

```bash
npm ci
npm run typecheck
npm test
npm run check
npm pack --dry-run
```

npm test는 프로젝트를 빌드한 뒤 Node test suite를 실행합니다. 테스트는 요청 크기·입력 검증, OAuth state/error/token 처리, project·auth 동작, tool-call 변환, SSE fragmentation·cancellation, Responses streaming 거부, IPv6 URL, daemon 안전성, CLI 옵션, package metadata를 다룹니다.

실제 계정으로 smoke test를 하려면:

```bash
npm run build
node dist/cli.js --detach
./examples/curl.sh
node dist/cli.js stop
```

유효한 계정 세션과 해당 계정에서 사용할 수 있는 모델이 필요합니다. 실제 인증 정보나 live 응답을 저장소에 추가하지 마세요.

## 제한사항 및 문제 해결

### 인증 정보를 찾지 못하는 경우

공식 CLI로 로그인하려면 gemini를 실행하거나 gemini-oauth login을 실행하세요. 선택된 경로는 다음으로 확인할 수 있습니다.

```bash
gemini-oauth status
```

### Project 해석이 실패하는 경우

사용자 소유 GCP project가 필요하거나 계정/tier가 Code Assist 대상이 아닐 수 있습니다. GOOGLE_CLOUD_PROJECT 또는 --project를 설정한 뒤 재시도하세요. upstream 비공개 API가 이 저장소와 별개로 변경된 경우에도 실패할 수 있습니다.

### 포트가 이미 사용 중인 경우

gemini-oauth status와 gemini-oauth stop을 사용하거나 --port로 다른 포트를 선택하세요. foreground 두 번째 인스턴스는 --force가 필요하며 일반적으로 다른 포트를 사용해야 합니다.

### 원격 클라이언트가 접속하지 못하는 경우

기본 host는 의도적으로 127.0.0.1입니다. 원격 접속이 정말 필요하다면 --host와 --allow-remote를 사용하고, 인증·암호화가 적용된 reverse proxy 또는 private network를 앞에 두세요. gemini-oauth 자체에는 API key나 사용자 인증 계층이 없습니다.

## 라이선스 및 법적 주의사항

### 이 저장소의 라이선스

이 저장소의 원본 소스 코드와 문서는 MIT License, copyright © 2026 gemini-oauth contributors로 공개됩니다. MIT는 저작권 및 라이선스 고지를 유지하는 조건에서 라이선스된 프로젝트 코드를 사용·복사·수정·배포·재허가·판매할 수 있도록 허용합니다. 소프트웨어는 보증 없이 “as is”로 제공됩니다.

MIT 라이선스는 이 저장소의 자료에만 적용됩니다. 다음 권리를 부여하지 않습니다.

- Google의 이름·로고·상표·브랜드를 사용할 권리
- Google 계정·OAuth 인증 정보·Code Assist quota·구독을 접근하거나 재배포할 권리
- Code Assist 비공개 endpoint를 공개 또는 공식 지원 API로 간주할 권리
- 계정·제품·rate·안전·지역 제한을 우회할 권리
- 다른 사람의 인증 정보나 모델 접근 권한을 재배포할 권리

### 제3자 서비스 및 계정에 대한 책임

이 도구는 Google OAuth, Gemini CLI / Code Assist 서비스, 그리고 경우에 따라 Antigravity 도구와 상호작용합니다. 각 서비스에는 별도의 이용약관·허용 사용 정책·개인정보처리방침·제품 제한·계정 정책이 있으며, 이 내용은 변경될 수 있습니다. 특히 구독 또는 관리형 Code Assist 권한을 제3자 클라이언트를 통해 사용할 계획이라면 계정과 지역에 적용되는 최신 조건을 사용 전에 확인하세요.

다음 사항은 사용자의 책임입니다.

- 본인이 권한을 가진 계정만 사용하고 인증 정보를 비공개로 유지할 것
- Google의 최신 약관·API/서비스 정책·Gemini CLI / Code Assist 규칙·조직 정책·관련 법률을 준수할 것
- prompt·파일·이미지·tool 입력·출력이 upstream 서비스에서 어떻게 처리되는지 이해할 것
- 적용되는 quota 또는 과금 결과를 확인할 것
- 이 소프트웨어의 사용·배포가 Google의 승인을 암시하지 않도록 할 것

이 프록시는 비공개 upstream protocol과 기존 도구에 호환되는 client metadata를 사용하므로 Google이 언제든 동작을 변경하거나 제한할 수 있습니다. 이 프로젝트는 지속적인 접근·모델 이용 가능성·quota·호환성·계정 안전을 보장하지 않습니다. 사용이 허용된다고 확인한 범위에서만 사용하세요.

## 면책

비공식 커뮤니티 프로젝트이며, 보증이나 지원 없이 제공됩니다. 사용으로 인한 계정 정지·quota 소비·데이터 손실·서비스 변경 또는 기타 결과에 대해 유지관리자는 책임지지 않습니다.
