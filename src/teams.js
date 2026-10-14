// NBA teams: tricode → id (for logos), name, primary and secondary colors.
export const TEAMS = {
  ATL: { id: 1610612737, name: 'Hawks', city: 'Atlanta', c1: '#C8102E', c2: '#FDB927' },
  BOS: { id: 1610612738, name: 'Celtics', city: 'Boston', c1: '#007A33', c2: '#BA9653' },
  CLE: { id: 1610612739, name: 'Cavaliers', city: 'Cleveland', c1: '#860038', c2: '#FDBB30' },
  NOP: { id: 1610612740, name: 'Pelicans', city: 'New Orleans', c1: '#0C2340', c2: '#C8102E' },
  CHI: { id: 1610612741, name: 'Bulls', city: 'Chicago', c1: '#CE1141', c2: '#000000' },
  DAL: { id: 1610612742, name: 'Mavericks', city: 'Dallas', c1: '#00538C', c2: '#B8C4CA' },
  DEN: { id: 1610612743, name: 'Nuggets', city: 'Denver', c1: '#0E2240', c2: '#FEC524' },
  GSW: { id: 1610612744, name: 'Warriors', city: 'Golden State', c1: '#1D428A', c2: '#FFC72C' },
  HOU: { id: 1610612745, name: 'Rockets', city: 'Houston', c1: '#CE1141', c2: '#C4CED4' },
  LAC: { id: 1610612746, name: 'Clippers', city: 'LA', c1: '#C8102E', c2: '#1D428A' },
  LAL: { id: 1610612747, name: 'Lakers', city: 'Los Angeles', c1: '#552583', c2: '#FDB927' },
  MIA: { id: 1610612748, name: 'Heat', city: 'Miami', c1: '#98002E', c2: '#F9A01B' },
  MIL: { id: 1610612749, name: 'Bucks', city: 'Milwaukee', c1: '#00471B', c2: '#EEE1C6' },
  MIN: { id: 1610612750, name: 'Timberwolves', city: 'Minnesota', c1: '#0C2340', c2: '#78BE20' },
  BKN: { id: 1610612751, name: 'Nets', city: 'Brooklyn', c1: '#000000', c2: '#FFFFFF' },
  NYK: { id: 1610612752, name: 'Knicks', city: 'New York', c1: '#006BB6', c2: '#F58426' },
  ORL: { id: 1610612753, name: 'Magic', city: 'Orlando', c1: '#0077C0', c2: '#C4CED4' },
  IND: { id: 1610612754, name: 'Pacers', city: 'Indiana', c1: '#002D62', c2: '#FDBB30' },
  PHI: { id: 1610612755, name: '76ers', city: 'Philadelphia', c1: '#006BB6', c2: '#ED174C' },
  PHX: { id: 1610612756, name: 'Suns', city: 'Phoenix', c1: '#1D1160', c2: '#E56020' },
  POR: { id: 1610612757, name: 'Trail Blazers', city: 'Portland', c1: '#E03A3E', c2: '#000000' },
  SAC: { id: 1610612758, name: 'Kings', city: 'Sacramento', c1: '#5A2D81', c2: '#63727A' },
  SAS: { id: 1610612759, name: 'Spurs', city: 'San Antonio', c1: '#C4CED4', c2: '#000000' },
  OKC: { id: 1610612760, name: 'Thunder', city: 'Oklahoma City', c1: '#007AC1', c2: '#EF3B24' },
  TOR: { id: 1610612761, name: 'Raptors', city: 'Toronto', c1: '#CE1141', c2: '#000000' },
  UTA: { id: 1610612762, name: 'Jazz', city: 'Utah', c1: '#002B5C', c2: '#F9A01B' },
  MEM: { id: 1610612763, name: 'Grizzlies', city: 'Memphis', c1: '#5D76A9', c2: '#12173F' },
  WAS: { id: 1610612764, name: 'Wizards', city: 'Washington', c1: '#002B5C', c2: '#E31837' },
  DET: { id: 1610612765, name: 'Pistons', city: 'Detroit', c1: '#C8102E', c2: '#1D42BA' },
  CHA: { id: 1610612766, name: 'Hornets', city: 'Charlotte', c1: '#1D1160', c2: '#00788C' },
};

// For the sticker album: complete a division to earn an Album Pack.
export const DIVISIONS = {
  Atlantic: ['BOS', 'BKN', 'NYK', 'PHI', 'TOR'],
  Central: ['CHI', 'CLE', 'DET', 'IND', 'MIL'],
  Southeast: ['ATL', 'CHA', 'MIA', 'ORL', 'WAS'],
  Northwest: ['DEN', 'MIN', 'OKC', 'POR', 'UTA'],
  Pacific: ['GSW', 'LAC', 'LAL', 'PHX', 'SAC'],
  Southwest: ['DAL', 'HOU', 'MEM', 'NOP', 'SAS'],
};

export const teamLogo = tri => TEAMS[tri] ? `https://cdn.nba.com/logos/nba/${TEAMS[tri].id}/global/L/logo.svg` : '';
export const headshot = pid => `https://cdn.nba.com/headshots/nba/latest/260x190/${pid}.png`;
