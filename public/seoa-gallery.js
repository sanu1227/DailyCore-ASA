export const PHOTOS = [
  { id: '01', title: '공식 프로필', file: 'portrait.jpg' },
  { id: '02', title: 'CHOOM · 비주얼 포토', file: 'choom.jpg' },
  { id: '03', title: 'MOON · 비주얼 포토', file: 'moon.jpg' },
  { id: '04', title: 'SUPA DUPA LUV · 비주얼 포토', file: 'supa-dupa-luv.jpg' }
];
export const PHOTO_GROUPS = {
  university: [2, 3, 4, 1], routines: [4, 1, 3, 2], activity: [3, 2, 1, 4],
  health: [4, 3, 1, 2], review: [2, 4, 3, 1], memory: [1, 3, 4, 2], settings: [3, 1, 2, 4]
};
export const photoPath = id => '/assets/asa/' + (PHOTOS.find(photo => photo.id === String(id).padStart(2, '0')) || PHOTOS[0]).file;
export function photoFor(view, offset = 0, date = new Date()) {
  const group = PHOTO_GROUPS[view] || PHOTO_GROUPS.memory;
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  return PHOTOS[group[((day + offset) % group.length + group.length) % group.length] - 1];
}
export function createSceneCards() {
  const cards = new Map();
  for (const view of Object.keys(PHOTO_GROUPS)) {
    const heading = document.querySelector('#view-' + view + ' .section-heading');
    if (!heading) continue;
    const card = document.createElement('aside'); card.className = 'seoa-scene-card';
    card.setAttribute('aria-label', '아사 사진');
    const image = document.createElement('img'); image.width = 1122; image.height = 1402;
    image.decoding = 'async'; image.dataset.seoaPhoto = '';
    image.onerror = () => {
      if (image.dataset.seoaPhoto === 'fallback') { image.hidden = true; return; }
      image.dataset.seoaPhoto = 'fallback'; image.src = '/assets/asa/portrait.jpg';
    };
    const copy = document.createElement('div'); copy.className = 'seoa-scene-copy';
    const title = document.createElement('small'); title.setAttribute('aria-live', 'polite');
    copy.append(title);
    const next = document.createElement('button'); next.type = 'button'; next.className = 'quiet';
    next.textContent = '다른 사진'; next.setAttribute('aria-label', '아사의 다른 사진 보기');
    const item = { image, title, offset: 0, selected: null };
    const update = () => {
      const photo = photoFor(view, item.offset);
      if (item.selected === photo.id) return;
      item.selected = photo.id; image.hidden = false; image.dataset.seoaPhoto = photo.id;
      image.alt = '아사 · ' + photo.title; image.src = photoPath(photo.id); title.textContent = photo.title;
    };
    next.onclick = () => { item.offset++; update(); };
    card.append(image, copy, next);
    if (view === 'routines' || view === 'review' || view === 'activity') heading.append(card);
    else heading.after(card);
    cards.set(view, update);
  }
  return { show(view) { cards.get(view)?.(); } };
}
