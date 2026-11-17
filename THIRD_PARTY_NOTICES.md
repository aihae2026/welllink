# 제3자 소프트웨어 고지 (THIRD_PARTY_NOTICES)

WellLink는 아래의 오픈소스 소프트웨어와 외부 서비스를 사용합니다. 각 소프트웨어의 저작권은 해당 제작자에게 있으며, 각자의 라이선스 조건을 따릅니다. WellLink 자체 소스코드의 라이선스는 [`LICENSE`](LICENSE)(Apache License 2.0), 문서·AI 평가 프롬프트의 라이선스는 [`LICENSE-DOCS.md`](LICENSE-DOCS.md)(CC BY 4.0)를 참고하세요.

- 라이선스는 설치된 각 패키지의 `package.json` 정보를 기준으로 확인했습니다. 버전은 `package.json`의 지정 값이며, 실제 설치 버전은 `bun.lock`에 고정되어 있습니다.
- 아래는 `package.json`에 직접 적은 의존성입니다. 이 패키지들이 다시 사용하는 하위 의존성은 `bun.lock`에서 확인할 수 있습니다.
- 이 저장소의 라이선스는 Supabase·Lovable·Google(Gemini API) 같은 **외부 서비스의 이용 조건을 바꾸지 못합니다.** 서비스는 각 사업자의 약관을 따릅니다.

## 1. 빌드 도구·프레임워크

| 이름 | 버전 | 용도 | 라이선스 |
| --- | --- | --- | --- |
| `nitro` | 3.0.260603-beta | 서버 빌드 도구(Cloudflare Worker 형태로 빌드). **베타 버전**이며 정식판이 나오면 올릴 예정 | MIT |
| `@lovable.dev/vite-tanstack-config` | ^2.20.0 | Lovable 호환 Vite·TanStack 빌드 설정 | MIT |
| `vite` | 8.1.6 | 개발 서버·번들러 | MIT |
| `@vitejs/plugin-react` | ^5.2.0 | Vite의 React 지원 | MIT |
| `vite-tsconfig-paths` | ^6.0.2 | TypeScript 경로 별칭 지원 | MIT |
| `@tanstack/react-start` | 1.168.61 | 풀스택 React 프레임워크 | MIT |
| `@tanstack/react-router` | 1.170.42 | 화면 라우팅 | MIT |
| `@tanstack/router-plugin` | 1.168.48 | 라우트 코드 생성 | MIT |
| `@tanstack/react-query` | ^5.101.1 | 서버 데이터 조회·캐시 | MIT |
| `react`, `react-dom` | ^19.2.0 | 웹 화면 구성 | MIT |
| `typescript` | ^5.8.3 | 애플리케이션 개발 언어 | Apache-2.0 |
| `tailwindcss`, `@tailwindcss/vite` | ^4.2.1 | 화면 스타일 | MIT |
| `tw-animate-css` | ^1.3.4 | 화면 전환 효과 스타일 | MIT |

## 2. 화면 구성요소 (UI)

| 이름 | 버전 | 용도 | 라이선스 |
| --- | --- | --- | --- |
| **shadcn/ui** (`src/components/ui/`에 복사해 사용한 컴포넌트 파일) | — | 버튼·대화상자·표 등 화면 컴포넌트. 패키지가 아니라 소스 파일을 복사해 쓰므로 아래 고지를 함께 둡니다. | MIT — Copyright (c) 2023 shadcn |
| `@radix-ui/react-*` (accordion, alert-dialog, aspect-ratio, avatar, checkbox, collapsible, context-menu, dialog, dropdown-menu, hover-card, label, menubar, navigation-menu, popover, progress, radio-group, scroll-area, select, separator, slider, slot, switch, tabs, toggle, toggle-group, tooltip) | ^1.x ~ ^2.x | 접근성을 갖춘 화면 구성요소 | MIT |
| `class-variance-authority` | ^0.7.1 | 컴포넌트 스타일 변형 관리 | Apache-2.0 |
| `clsx`, `tailwind-merge` | ^2.1.1, ^3.5.0 | 스타일 클래스 조합 | MIT |
| `lucide-react` | ^0.575.0 | 화면 아이콘 | ISC |
| `cmdk` | ^1.1.1 | 검색형 명령 목록 | MIT |
| `sonner` | ^2.0.7 | 알림 메시지 | MIT |
| `vaul` | ^1.1.2 | 하단 시트 | MIT |
| `embla-carousel-react` | ^8.6.0 | 캐러셀 | MIT |
| `react-resizable-panels` | ^4.6.5 | 크기 조절 패널 | MIT |
| `input-otp` | ^1.4.2 | 숫자 입력 칸(PIN 등) | MIT |
| `react-day-picker` | ^9.14.0 | 날짜 선택 | MIT |
| `recharts` | ^2.15.4 | 차트 | MIT |

## 3. 데이터·입력·파일 처리

| 이름 | 버전 | 용도 | 라이선스 |
| --- | --- | --- | --- |
| `@supabase/supabase-js` | ^2.110.9 | Supabase(인증·데이터베이스) 연동 | MIT |
| `zod` | ^3.24.2 | 입력값 검증 | MIT |
| `react-hook-form`, `@hookform/resolvers` | ^7.71.2, ^5.2.2 | 입력 양식 처리 | MIT |
| `date-fns` | ^4.1.0 | 날짜 처리 | MIT |
| `exceljs` | 4.4.0 | 실적보고 Excel 파일 생성·다운로드 | MIT |
| `xlsx` (SheetJS) | 0.20.3 | 수강명단·일정 Excel 파일 업로드·파싱 | Apache-2.0 |

> 참고: npm에 올라온 `xlsx` 0.18.5는 더 이상 수리판이 나오지 않고 알려진 보안 결함이 있어, **제작사(SheetJS) 공식 배포처(cdn.sheetjs.com)의 0.20.3으로 교체**했습니다. npm이 아닌 제작사 주소에서 내려받으므로 `package.json`에 주소가 직접 적혀 있습니다.

## 4. 개발 도구 (실행 파일에는 포함되지 않음)

| 이름 | 버전 | 용도 | 라이선스 |
| --- | --- | --- | --- |
| `eslint`, `@eslint/js`, `eslint-config-prettier`, `eslint-plugin-prettier`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `typescript-eslint`, `globals` | ^9.x 등 | 코드 검사 | MIT |
| `prettier` | ^3.7.3 | 코드 서식 | MIT |
| `@types/node`, `@types/react`, `@types/react-dom` | ^22.x, ^19.x | TypeScript 타입 정의 | MIT |

## 5. 외부 서비스 (소프트웨어 라이선스 대상이 아님)

| 서비스 | 용도 | 조건 |
| --- | --- | --- |
| Supabase | 사용자 인증, PostgreSQL 데이터베이스, 기관별 접근제어(RLS) | Supabase 이용 약관 |
| Lovable | UI 구성, 서비스 개발·배포 | Lovable 이용 약관 |
| Google Gemini API | AI 사업평가 초안 생성 | Google API 서비스 이용 약관 (요금제에 따라 입력 데이터 처리 조건이 다를 수 있음) |
| Cloudflare | 배포 환경(Worker) | Cloudflare 이용 약관 |

## 6. 이 저장소에서 쓰지 않은 것

`public/`에는 파비콘과 `robots.txt`만 있으며, 별도의 로고·글꼴 파일이나 외부 글꼴·CDN 호출은 없습니다.
