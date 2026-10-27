# 아사 사진 기록

이 앱은 BABYMONSTER 아사의 실제 공개 사진을 사용하는 개인용 팬메이드 AI입니다. 사진 속 인물과 AI 답변을 구분하며, 공식 서비스나 실제 인물과의 대화로 표시하지 않습니다.

## 사용 방식

- 상세 앱의 기본 사진: `public/assets/asa/moon.jpg`(1707×2560).
- 사진 선택: `MOON`, `CHOOM`, `SUPA DUPA LUV`. 작은 아이콘과 알림에는 공식 프로필 `portrait.jpg`(364×364)를 사용합니다.
- 공식 채널의 실제 사진을 대화·홈·각 화면 카드·알림에 표시합니다. 생성한 얼굴이나 표정 프레임으로 대체하지 않습니다.
- 움직임은 사진 전체의 완만한 CSS 이동·확대 효과입니다. 눈 깜박임, 입 모양, 고개 움직임을 새로 합성하지 않습니다.
- 설정의 사진 움직임을 끄거나 운영체제의 동작 줄이기를 켜면 정지합니다. 숨겨진 창에서도 정지합니다.
- 이전 백서아 자산은 이 사진 목록에 포함하지 않습니다. 이전 개발 기록은 별도 문서에 보존합니다.

## 출처와 파일 목록

2026-10-19 기준 실제 사진 4장을 사용합니다. 저작권 표기는 © YG ENTERTAINMENT입니다.

| 로컬 파일 | 사진 | 공식 출처 |
| --- | --- | --- |
| `portrait.jpg` | 공식 프로필 | [YG BABYMONSTER 프로필](https://www.ygfamily.com/ko/artists/babymonster/profile) |
| `choom.jpg` | CHOOM · 비주얼 포토 | [YG LIFE · CHOOM](https://yg-life.com/archives/196539?lang=en) |
| `moon.jpg` | MOON · 비주얼 포토 | [YG LIFE · MOON](https://yg-life.com/archives/197541?lang=en) |
| `supa-dupa-luv.jpg` | SUPA DUPA LUV · 비주얼 포토 | [YG LIFE · SUPA DUPA LUV](https://yg-life.com/archives/195883?lang=en) |

파일은 `public/assets/asa/`에 보관합니다. 원본 이미지 URL·수집일·파일별 SHA-256·바이트 수는 [sources.json](../public/assets/asa/sources.json)에 기록합니다. 공식 채널의 공개 사진이라는 사실이 이 앱의 공식 제휴나 사진 재배포 허가를 의미하지는 않습니다.
