# 화이트보드 강의 — 재생기

짧은 강의 대본(글)을 받아 화이트보드에 펜으로 판서하는 모습을 보여 주고(해설은 자막), 그 강의를 MP4 영상 파일로 저장하는 웹 페이지입니다.
서버 없이 이 폴더의 파일만으로 동작하며, 외부 서버를 부르지 않습니다.

- 주소 뒤에 대본을 붙여 엽니다: `#t=<대본 글(퍼센트 인코딩)>` · `#z=<압축 대본>` · `#s=<base64url 대본>`. 대본이 없으면 붙여넣기 칸이 뜹니다.
- 「영상 저장」: WebCodecs(H.264)로 브라우저 안에서 MP4 를 만듭니다(지원하지 않는 브라우저는 실시간 녹화).

## 라이선스
- 글꼴: 판서·자막에 쓰는 글자 모양(`fonts/chunks/`)은 아래 글꼴의 윤곽에서 만든 것이며, 각 글꼴은 SIL Open Font License 1.1 을 따릅니다. 원 글꼴 이름(예약 글꼴 이름 포함)으로 다시 배포하는 글꼴 파일이 아닙니다.
- `fonts/poorstory/OFL.txt` — 글꼴 'poorstory'(PoorStory-Regular)
- `fonts/yomogi/OFL.txt` — 글꼴 'yomogi'(Yomogi-Regular)
- `fonts/nanumgothic/OFL.txt` — 글꼴 'gothic'(NanumGothic-Regular)
- `fonts/notosansmath/OFL.txt` — 글꼴 'math'(NotoSansMath-Regular)
- mp4-muxer 5.2.2 — MIT(`vendor/mp4-muxer.LICENSE`), Copyright (c) 2023 Vanilagy
- 재생기 코드(`index.html`, `player.js`, `export.js`, `core/`) — 저장소 주인이 정함(이 파일에 별도 라이선스를 적지 않았습니다)
