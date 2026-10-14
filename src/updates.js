// "What's new" for players. Add an entry whenever a change affects how people
// play or what they see. Commissioner-only changes don't go here.
// Ids only ever increase; everyone sees entries newer than the last one they read.

export const UPDATES = [
  {
    id: 1,
    date: '2026-10-15',
    title: 'A fourth pick: Dub',
    items: [
      'New weekly pick, Dub: choose a team and it scores its wins that week. Each team can be your Dub once a season.',
      'Survivor now asks you to clear 3 of 4 bars each week: 50 points, 18 rebounds, 15 assists and 1 win. The bars are the same every week, double weeks included.',
      'A quick tour of the rules now greets everyone. Replay it any time from the Rules tab.',
    ],
  },
];

export const LATEST_UPDATE = UPDATES.reduce((m, u) => Math.max(m, u.id), 0);
