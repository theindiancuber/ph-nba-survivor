// "What's new" for players. Add an entry whenever a change affects how people
// play or what they see. Commissioner-only changes don't go here.
// Ids only ever increase; everyone sees entries newer than the last one they read.

export const UPDATES = [
  {
    id: 16,
    date: '2026-10-20',
    title: 'Burn Notice is ultra rare',
    items: [
      'From Week 3, Burn Notice turns up in about 1 in 330 packs for the leader, rising to about 1 in 52 for last place late in the season.',
      'Live scores now refresh about every 8 minutes while games are on.',
    ],
  },
  {
    id: 15,
    date: '2026-10-20',
    title: 'Live points only count games played',
    items: [
      "During a live week, once your pick has played he's ranked against everyone: picks still waiting to play count as 0, so any points he scores beat them.",
      "A pick that hasn't played yet shows 0 for now, instead of collecting points for being tied with all the other 0s.",
      'Final scores are worked out exactly as before.',
    ],
  },
  {
    id: 13,
    date: '2026-10-20',
    title: 'Pack odds that follow the table',
    items: [
      'From Week 3, pack odds slide with where you are in the standings and how far into the season it is. The further down you are, the better your odds of Rares and Burn Notice, and that help grows as the season goes on.',
      'Burn Notice and Rares are rarer for everyone.',
      'Heist and Blue Shell still only reach the bottom half of the standings.',
    ],
  },
  {
    id: 12,
    date: '2026-10-20',
    title: 'Kept cards are final',
    items: [
      'Swapping the card you kept from a pack was a Week 1 thing while everyone learned the cards. From now on, the card you keep is the one you get.',
      'Swaps made in Week 1 still stand.',
    ],
  },
  {
    id: 11,
    date: '2026-10-20',
    title: 'No free points at the lock',
    items: [
      "Before any games, every pick is tied at 0, and ties pay ½ a point per colleague, so everyone showed 22 points (27.5 with a Double Down) the moment Week 1 locked.",
      "Now a category only starts scoring once someone's pick in it has played. Everyone starts the week at 0, and final scores are worked out exactly as before.",
    ],
  },
  {
    id: 10,
    date: '2026-10-20',
    title: 'Results, your week at a glance',
    items: [
      'Jump to any locked week from the dropdown on Results — handy once the season gets long.',
      'A strip at the top of Results shows your place, points, bars cleared, and which cards hit you that week.',
    ],
  },
  {
    id: 9,
    date: '2026-10-19',
    title: 'A fresh new look',
    items: [
      'The whole app has been redesigned: cleaner type, calmer colours and everything lined up, on phones too.',
      "A new league badge: the Peakhill Capital peak on an NBA-style navy and red panel, with a shot dropping off the summit.",
      'Pop-ups slide up from the bottom on a phone, and the news ticker pauses when you hover over it.',
      'Signed out, you only see the sign-in page and the Rules, since everything else needs an account.',
    ],
  },
  {
    id: 8,
    date: '2026-10-19',
    title: 'Straight from the Commissioner',
    items: [
      'Announcements from the commissioner now appear as a banner at the top of the app. Tap × to dismiss one.',
      "If the commissioner changes a rule (like a survival bar), it's listed on the Rules tab with the week it starts. Weeks already played keep their rules.",
      'Any point or life corrections show on that week\'s Results, with the reason.',
    ],
  },
  {
    id: 7,
    date: '2026-10-14',
    title: 'A guided tour',
    items: [
      'The quick tour now walks you through the real app, spotlighting the countdown, your pick slots, backups, the survival bars, Jokers, each tab, your cards and the Card Dex.',
      'Replay it any time from the Rules tab. Use the arrow keys or Next and Back to move through it, and Skip to leave.',
    ],
  },
  {
    id: 6,
    date: '2026-10-14',
    title: "The Commissioner's Decree",
    items: [
      'Up to 3 times a season the commissioner sets a one-week twist: Prime Time (a category counts double), Opposite Day, Bounty, Mercy Rule, Sudden Death, Amnesty, Ceasefire, Free-for-all or Pack Day.',
      'Sometimes you get a vote instead. Watch for the ballot on This Week; most votes wins.',
      'Decrees go up, and votes close, at least 24 hours before the lock. The Rules tab lists every twist.',
    ],
  },
  {
    id: 5,
    date: '2026-10-14',
    title: 'Second thoughts and practice packs',
    items: [
      "Changed your mind after opening a pack? You can swap the card you kept for one of the other two, once per pack, until that week's lock. Open the card in Your hand and choose Swap it.",
      'Everyone gets 2 practice packs on the Cards tab to see what a pull is like. Practice cards don\'t stick.',
    ],
  },
  {
    id: 4,
    date: '2026-10-14',
    title: 'The card table levels up',
    items: [
      'A new dashboard on the Cards tab shows your hand, whether your weekly play is ready, your traps and your collection.',
      'The Card Dex: collect all 17 cards. Tap any card to see what it does, when to play it and a tip, and play or gift it from there.',
      '10 achievements to unlock, from Pack Rat to Card Master.',
      'A shorter "How cards work" guide.',
    ],
  },
  {
    id: 3,
    date: '2026-10-14',
    title: 'Joker cards are here',
    items: [
      'A new Cards tab: earn packs (mostly by making your own picks), keep one card from each, and play one card a week.',
      '17 cards: jinxes, traps, duels, heists, Blue Shells, pranks and more. Everything is revealed at the lock, and cards never cost you a life.',
      'New to cards? Read the card primer at the top of the Cards tab.',
    ],
  },
  {
    id: 2,
    date: '2026-10-14',
    title: 'More trophies to chase',
    items: [
      'New title belts: Scoring, Rebounding, Assists and Dub Champions, for the most of each from your picks over the season.',
      'New Hall of Fame awards, including Week Winner, Category Killer, Heater of the Year, Iron Man, Galaxy Brain, Mr. Consistent, Most Improved, Insurance Agent, Joker Smoker and Rival Slayer.',
      "And a Hall of Shame (Fumble King, Asleep at the Wheel, Ice Cold, Chalk Merchant), so it's worth paying attention.",
      'Every award comes with a certificate. The Trophies tab shows who leads each race right now and where you stand.',
    ],
  },
  {
    id: 1,
    date: '2026-10-14',
    title: 'A fourth pick: Dub',
    items: [
      'New weekly pick, Dub: choose a team and it scores its wins that week. Each team can be your Dub once a season.',
      'Survivor now asks you to clear 3 of 4 bars each week: 50 points, 18 rebounds, 15 assists and 1 win. The bars are the same every week, double weeks included.',
      'A quick tour of the rules now greets everyone. Replay it any time from the Rules tab.',
    ],
  },
];

export const LATEST_UPDATE = UPDATES.reduce((m, u) => Math.max(m, u.id), 0);
