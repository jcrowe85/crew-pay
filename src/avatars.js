// Cartoon avatars a person can pick. Each id is a file in public/avatars/<id>.svg (Twemoji art, CC-BY 4.0).
const GROUPS = [
  ['Fun', [
    'fox', 'panda', 'lion', 'tiger', 'bear', 'koala', 'monkey', 'dog', 'cat', 'rabbit', 'frog', 'pig', 'cow',
    'penguin', 'owl', 'chick', 'unicorn', 'dragon', 'trex', 'octopus', 'shark', 'whale', 'bee', 'sloth', 'raccoon',
    'robot', 'alien', 'cowboy', 'cool', 'nerd', 'party', 'ninja', 'rocket', 'cactus', 'pizza', 'taco',
  ]],
  ['Halloween', [
    'pumpkin', 'ghost', 'vampire', 'witch', 'zombie', 'skull', 'crossbones', 'bat', 'spider', 'web', 'black-cat',
    'wolf', 'monster', 'ogre', 'goblin', 'clown', 'devil', 'candy', 'lollipop', 'coffin', 'headstone',
    'crystal-ball', 'moon', 'candle',
  ]],
];
const IDS = new Set(GROUPS.flatMap(([, ids]) => ids));
const LABELS = { trex: 'T-rex', cool: 'Sunglasses', party: 'Party face', web: 'Spider web', crossbones: 'Skull and crossbones' };
const label = (id) => LABELS[id] || id[0].toUpperCase() + id.slice(1).replace(/-/g, ' ');

module.exports = { GROUPS, label, isAvatar: (id) => IDS.has(id) };
