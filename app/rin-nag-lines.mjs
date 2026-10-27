// Original Korean notification copy for the ASA fanmade AI app, not artist quotes.
const hash = value => [...String(value)].reduce((result, char) => Math.imul(result ^ char.charCodeAt(0), 16777619) >>> 0, 2166136261);
const mix = (seed, salt) => {
  let value = (seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16; value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13; value = Math.imul(value, 0xc2b2ae35) >>> 0;
  return (value ^ value >>> 16) >>> 0;
};
const pick = (items, seed, salt) => items[mix(seed, salt) % items.length];

const DEADLINE_TITLES = [
  "아사 · 마감 확인",
  "아사 · 곧 마감이야",
  "아사 · 남은 시간",
  "아사 · 지금 할 일",
  "아사 · 제출 확인",
  "아사 · 잠깐 확인해"
];
const DEADLINE_OPENERS = [
  "{label}, {timing}까지 {time} 남았어.",
  "{label}, 지금 남은 시간은 {time}이야.",
  "{time} 뒤에 {label} {timing}이야.",
  "{label} 확인할 시간이야. {timing}까지 {time} 남았어.",
  "{label}, 앞으로 {time}이야.",
  "게임 중인 건 아는데, {label} {timing}까지 {time} 남았어.",
  "{label} 준비할 시간이 {time} 남아 있어.",
  "{label} {timing}이 {time} 앞으로 왔어."
];
const CRITICAL_OPENERS = [
  "{label}, 이제 {time} 남았어.",
  "{time} 뒤에 {label} {timing}이야.",
  "{label} {timing}이 가까워. {time} 남았어.",
  "{label}, {timing}까지 남은 시간은 {time}이야.",
  "{label} 확인하자. {time} 뒤면 {timing}이야.",
  "{label} 준비할 시간이 {time} 남았어.",
  "{label}부터 챙기자. {time} 남았어.",
  "{label} {timing}까지 {time}. 시간이 얼마 안 남았어."
];
const ACTIONS = [
  "게임은 저장해 두고, 남은 부분부터 보자.",
  "어디까지 했는지 먼저 확인해 볼까.",
  "제출할 파일부터 한번 확인해 줘.",
  "빠진 조건 있는지만 먼저 봐.",
  "잠깐 집중해서 마무리할 부분부터 보자.",
  "일단 파일부터 열어 보자.",
  "첨부 파일이랑 제출 위치 확인해 줘.",
  "남은 분량부터 같이 정리해 보자.",
  "게임은 잠깐 멈추고 이것부터 챙기자.",
  "지금 할 수 있는 부분부터 하자.",
  "초안이 있으면 거기서 이어 하자.",
  "다 했으면 제출까지 확인해 줘."
];
const EXAM_ACTIONS = ['시험 범위랑 준비물 한번 확인해 줘.', '게임은 저장해 두고, 헷갈리는 부분부터 보자.', '준비한 내용 가볍게 훑어보자.', '시험 장소랑 시작 시간 다시 한번 봐.'];
const EVENT_ACTIONS = ['장소랑 준비할 것 확인해 줘.', '하던 거 정리하고 슬슬 준비하자.', '이동해야 하면 출발할 시간도 봐.', '게임은 저장해 두고 이 일정부터 챙기자.'];
const BEDTIME_TITLES = [
  "아사 · 잘 시간",
  "아사 · 취침 준비",
  "아사 · 오늘은 여기까지",
  "아사 · 이제 쉬자",
  "아사 · 수면 일정"
];
const BEDTIME_OPENERS = [
  "정해 둔 {routine} 시간이 됐어.",
  "{routine}, 이제 준비할 시간이야.",
  "{routine} 시간이야. 오늘은 슬슬 정리하자.",
  "{routine}, 정해 둔 시간이 됐어.",
  "{routine} 시간이네. 게임은 슬슬 마무리하자.",
  "{routine}, 오늘 정해 둔 시간이야.",
  "이제 {routine} 준비하자.",
  "{routine} 시간이야. 오늘은 이쯤 할까."
];
const BEDTIME_ENDINGS = [
  "저장할 수 있는 데까지만 하고 쉬자.",
  "잠들기 전에 화면도 잠깐 내려놓고.",
  "내일 쓸 기운도 남겨 두자.",
  "남은 게임은 내일 이어 하자.",
  "잘 자. 오늘은 여기까지 하자.",
  "게임 끄기 전에 저장은 잊지 말고.",
  "하던 건 저장해 두고 이어 하자.",
  "다음 판은 내일 해도 되잖아."
];

const BREAK_TITLES = [
  "아사 · 잠깐 쉬자",
  "아사 · 휴식 시간",
  "아사 · 눈도 쉬어야지",
  "아사 · 잠깐 쉬었다 하자"
];
const BREAK_OPENERS = [
  "PC를 연속으로 {minutes}분 썼어.",
  "PC 사용 {minutes}분째야. 잠깐 쉴까.",
  "{minutes}분 지났어. 잠깐 쉬었다 하자.",
  "벌써 {minutes}분째네. 잠깐 쉬어 가자.",
  "연속으로 {minutes}분 사용했어.",
  "{minutes}분 지났어. 잠깐 숨 돌리자.",
  "PC 사용 {minutes}분째야. 쉬어 갈 시간이야.",
  "{minutes}분 썼어. 하던 건 잠깐 두자."
];
const BREAK_ENDINGS = [
  "어깨 한번 풀어 주고.",
  "잠깐 일어나서 움직여도 좋고.",
  "물 한 모금 챙겨도 좋고.",
  "화면 말고 먼 곳 좀 보자.",
  "어디까지 했는지만 표시해 두고.",
  "손목도 가볍게 풀어 주고.",
  "앉은 자세도 한번 바꿔 봐.",
  "눈도 잠깐 쉬게 해 주자."
];

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');

export function buildDeadlineNagCopy({ label, noun, time, gameMinutes = 0, retryMinutes, key }) {
  const seed = hash(key);
  const critical = /분$/.test(time) || (Number.parseInt(time, 10) <= 3 && /시간$/.test(time));
  const assignment = noun !== '시험' && noun !== '일정';
  const opener = fill(pick(critical ? CRITICAL_OPENERS : DEADLINE_OPENERS, seed, 1), { label, time, timing: assignment ? '마감' : '시작' });
  const usage = gameMinutes >= 30 ? ` 오늘 게임 기록은 ${[Math.floor(gameMinutes / 60) ? `${Math.floor(gameMinutes / 60)}시간` : '', gameMinutes % 60 ? `${gameMinutes % 60}분` : ''].filter(Boolean).join(' ')}이야.` : '';
  const action = pick(noun === '시험' ? EXAM_ACTIONS : noun === '일정' ? EVENT_ACTIONS : ACTIONS, seed, 2);
  const repeat = retryMinutes ? ` ${retryMinutes}분 뒤에 다시 알려 줄게.` : '';
  return { title: assignment ? pick(DEADLINE_TITLES, seed, 4) : `아사 · ${noun} 시간 확인`, body: `${opener}${usage} ${action}${repeat}`.replace(/\s+/g, ' ').trim() };
}

export function buildBedtimeNagCopy({ routine, key }) {
  const seed = hash(key);
  return { title: pick(BEDTIME_TITLES, seed, 5), body: `${fill(pick(BEDTIME_OPENERS, seed, 6), { routine })} ${pick(BEDTIME_ENDINGS, seed, 7)}` };
}

export function buildBreakNagCopy({ minutes, key }) {
  const seed = hash(key);
  return { title: pick(BREAK_TITLES, seed, 8), body: `${fill(pick(BREAK_OPENERS, seed, 9), { minutes })} ${pick(BREAK_ENDINGS, seed, 10)}` };
}
