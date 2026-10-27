// Shared notification categories. Playback now maps these to chimes, never archived character voices.
exports.notificationVoiceCategory = (candidate = {}, now = new Date()) => {
  const key = String(candidate.key || '');
  const title = String(candidate.title || '');
  if (candidate.display === 'daily-review' || key.startsWith('evening-review:')) return 'review';
  if (key.startsWith('briefing:')) return now.getHours() >= 5 && now.getHours() < 12 ? 'greeting' : 'casual';
  if (key.startsWith('game:') || key.startsWith('deadline-') || key.startsWith('academic:')) return 'priority';
  if (key.startsWith('away:')) return 'away';
  if (key.startsWith('bedtime-game:') || /잘 시간|취침|수면/.test(title)) return 'bedtime';
  if (key.startsWith('focus-end:')) return 'success';
  if (key.startsWith('activity-break:') || key.startsWith('health-check:') || /쉬어|물/.test(title)) return 'break';
  if (/식사|아침|점심|저녁|밥/.test(title)) return 'meal';
  if (key.startsWith('class:') || /공부|학습|집중|운동/.test(title)) return 'study';
  return 'casual';
};
