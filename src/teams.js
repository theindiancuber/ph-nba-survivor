import { SPORT } from './config.js';

// NBA teams: tricode → id (for logos), name, primary and secondary colors.
const NBA_TEAMS = {
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

// NHL teams, by the NHL's own team ids (they never collide with NHL player ids, which run in the millions).
const NHL_TEAMS = {
  ANA: { id: 24, name: 'Ducks', city: 'Anaheim', c1: '#F47A38', c2: '#B9975B' },
  BOS: { id: 6, name: 'Bruins', city: 'Boston', c1: '#111111', c2: '#FFB81C' },
  BUF: { id: 7, name: 'Sabres', city: 'Buffalo', c1: '#003087', c2: '#FFB81C' },
  CGY: { id: 20, name: 'Flames', city: 'Calgary', c1: '#C8102E', c2: '#F1BE48' },
  CAR: { id: 12, name: 'Hurricanes', city: 'Carolina', c1: '#CC0000', c2: '#000000' },
  CHI: { id: 16, name: 'Blackhawks', city: 'Chicago', c1: '#CF0A2C', c2: '#000000' },
  COL: { id: 21, name: 'Avalanche', city: 'Colorado', c1: '#6F263D', c2: '#236192' },
  CBJ: { id: 29, name: 'Blue Jackets', city: 'Columbus', c1: '#002654', c2: '#CE1126' },
  DAL: { id: 25, name: 'Stars', city: 'Dallas', c1: '#006847', c2: '#8F8F8C' },
  DET: { id: 17, name: 'Red Wings', city: 'Detroit', c1: '#CE1126', c2: '#FFFFFF' },
  EDM: { id: 22, name: 'Oilers', city: 'Edmonton', c1: '#041E42', c2: '#FF4C00' },
  FLA: { id: 13, name: 'Panthers', city: 'Florida', c1: '#C8102E', c2: '#041E42' },
  LAK: { id: 26, name: 'Kings', city: 'Los Angeles', c1: '#111111', c2: '#A2AAAD' },
  MIN: { id: 30, name: 'Wild', city: 'Minnesota', c1: '#154734', c2: '#A6192E' },
  MTL: { id: 8, name: 'Canadiens', city: 'Montréal', c1: '#AF1E2D', c2: '#192168' },
  NSH: { id: 18, name: 'Predators', city: 'Nashville', c1: '#041E42', c2: '#FFB81C' },
  NJD: { id: 1, name: 'Devils', city: 'New Jersey', c1: '#CE1126', c2: '#000000' },
  NYI: { id: 2, name: 'Islanders', city: 'New York', c1: '#00539B', c2: '#F47D30' },
  NYR: { id: 3, name: 'Rangers', city: 'New York', c1: '#0038A8', c2: '#CE1126' },
  OTT: { id: 9, name: 'Senators', city: 'Ottawa', c1: '#C52032', c2: '#000000' },
  PHI: { id: 4, name: 'Flyers', city: 'Philadelphia', c1: '#F74902', c2: '#000000' },
  PIT: { id: 5, name: 'Penguins', city: 'Pittsburgh', c1: '#111111', c2: '#FCB514' },
  SJS: { id: 28, name: 'Sharks', city: 'San Jose', c1: '#006D75', c2: '#EA7200' },
  SEA: { id: 55, name: 'Kraken', city: 'Seattle', c1: '#001628', c2: '#99D9D9' },
  STL: { id: 19, name: 'Blues', city: 'St. Louis', c1: '#002F87', c2: '#FCB514' },
  TBL: { id: 14, name: 'Lightning', city: 'Tampa Bay', c1: '#002868', c2: '#FFFFFF' },
  TOR: { id: 10, name: 'Maple Leafs', city: 'Toronto', c1: '#00205B', c2: '#FFFFFF' },
  UTA: { id: 68, name: 'Mammoth', city: 'Utah', c1: '#1F2A44', c2: '#71AFE5' },
  VAN: { id: 23, name: 'Canucks', city: 'Vancouver', c1: '#00205B', c2: '#00843D' },
  VGK: { id: 54, name: 'Golden Knights', city: 'Vegas', c1: '#333F42', c2: '#B4975A' },
  WSH: { id: 15, name: 'Capitals', city: 'Washington', c1: '#041E42', c2: '#C8102E' },
  WPG: { id: 52, name: 'Jets', city: 'Winnipeg', c1: '#041E42', c2: '#004C97' },
};

export const TEAMS = SPORT === 'nhl' ? NHL_TEAMS : NBA_TEAMS;

export const TEAM_BY_ID = Object.fromEntries(Object.entries(TEAMS).map(([tri, t]) => [t.id, tri]));
export const isTeamId = id => id in TEAM_BY_ID;
// For the sticker album: complete a division to earn an Album Pack.
const NBA_DIVISIONS = {
  Atlantic: ['BOS', 'BKN', 'NYK', 'PHI', 'TOR'],
  Central: ['CHI', 'CLE', 'DET', 'IND', 'MIL'],
  Southeast: ['ATL', 'CHA', 'MIA', 'ORL', 'WAS'],
  Northwest: ['DEN', 'MIN', 'OKC', 'POR', 'UTA'],
  Pacific: ['GSW', 'LAC', 'LAL', 'PHX', 'SAC'],
  Southwest: ['DAL', 'HOU', 'MEM', 'NOP', 'SAS'],
};

const NHL_DIVISIONS = {
  Atlantic: ['BOS', 'BUF', 'DET', 'FLA', 'MTL', 'OTT', 'TBL', 'TOR'],
  Metropolitan: ['CAR', 'CBJ', 'NJD', 'NYI', 'NYR', 'PHI', 'PIT', 'WSH'],
  Central: ['CHI', 'COL', 'DAL', 'MIN', 'NSH', 'STL', 'UTA', 'WPG'],
  Pacific: ['ANA', 'CGY', 'EDM', 'LAK', 'SJS', 'SEA', 'VAN', 'VGK'],
};
export const DIVISIONS = SPORT === 'nhl' ? NHL_DIVISIONS : NBA_DIVISIONS;

// NHL headshots need the player's team and the season, so players.json carries each one's URL (img).
export const teamLogo = tri => !TEAMS[tri] ? '' : SPORT === 'nhl'
  ? `https://assets.nhle.com/logos/nhl/svg/${tri}_dark.svg`
  : `https://cdn.nba.com/logos/nba/${TEAMS[tri].id}/global/L/logo.svg`;
export const headshot = (pid, p) => SPORT === 'nhl' ? p?.img || '' : `https://cdn.nba.com/headshots/nba/latest/260x190/${pid}.png`;
