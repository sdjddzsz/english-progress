/**
 * mock-data.mjs —— e2e 复现用的云端表 mock 数据（与真实库同构、同数量级）。
 * 只服务 e2e/mock-server.mjs；不进生产构建。
 */

export const USER_ID = 'e2e-user-1';
export const BOOK_ID = 'e2e-book-1';
export const PLAN_ID = 'e2e-plan-1';

const NOW = Date.now();
const iso = (offsetDays = 0) => new Date(NOW + offsetDays * 86400000).toISOString();

/** 300 个词：词形/音标/义项按真实 Word 形状造（ sensesDetail 带读音） */
function makeWords(n = Number(process.env.E2E_WORD_COUNT ?? 300)) {
  const lemmas = [
    'abandon', 'ability', 'absorb', 'abstract', 'academy', 'access', 'accompany', 'accumulate', 'accurate', 'accuse',
    'achieve', 'acquire', 'adapt', 'adequate', 'adjacent', 'adjust', 'administer', 'admit', 'adolescent', 'advance',
    'advocate', 'aesthetic', 'affiliate', 'afford', 'aggressive', 'allocate', 'alternative', 'ambiguous', 'ambitious', 'amend',
    'analogy', 'analyze', 'ancestor', 'announce', 'annual', 'anticipate', 'apparent', 'appeal', 'appetite', 'applaud',
    'apply', 'appoint', 'appreciate', 'approach', 'appropriate', 'approve', 'arbitrary', 'archive', 'argue', 'arise',
    'articulate', 'aspect', 'assemble', 'assert', 'assess', 'assign', 'assist', 'associate', 'assume', 'assure',
    'attach', 'attempt', 'attend', 'attitude', 'attribute', 'audience', 'authentic', 'authorize', 'automate', 'available',
    'average', 'avoid', 'aware', 'balance', 'barrier', 'benefit', 'bias', 'bind', 'biological', 'blend',
    'border', 'brief', 'budget', 'bulk', 'burden', 'bury', 'calculate', 'campaign', 'capable', 'capture',
    'career', 'cautious', 'cease', 'challenge', 'channel', 'character', 'charity', 'chart', 'chronic', 'circuit',
  ];
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const lemma = lemmas[i % lemmas.length] + (i >= lemmas.length ? `_${Math.floor(i / lemmas.length)}` : '');
    const arpabet = 'AH0 B AE1 N D AH0 N';
    out.push({
      id: `e2e-word-${i + 1}`,
      lemma,
      ipa: '/əˈbændən/',
      arpabet,
      pos: 'v.',
      senses: ['放弃，抛弃', '沉溺于'],
      sensesDetail: [
        {
          senseId: `${lemma}#0`,
          lemma,
          pos: 'v.',
          zh: '放弃，抛弃',
          pronunciationKey: `${lemma}#0`,
          arpabet,
          ipa: '/əˈbændən/',
        },
        {
          senseId: `${lemma}#1`,
          lemma,
          pos: 'n.',
          zh: '放任，纵情',
          pronunciationKey: `${lemma}#1`,
          arpabet,
          ipa: '/əˈbændən/',
        },
      ],
      examples: [],
      frequency: 1000 - i,
      tags: ['cet6'],
    });
  }
  return out;
}

export const words = makeWords();

export const books = [
  {
    id: BOOK_ID,
    owner_id: USER_ID,
    userId: USER_ID,
    name: '六级核心词（e2e）',
    source: 'ecdict',
    wordCount: words.length,
    tierCount: 4,
    listSize: 50,
    status: 'active',
    createdAt: iso(-30),
  },
];

/** book_words：stage 1 ≈ 98% / stage 2 ≈ 2%（复刻真实库 8127/169 的悬殊比例） */
export const bookWords = words.map((w, i) => ({
  id: `e2e-bw-${i + 1}`,
  owner_id: USER_ID,
  bookId: BOOK_ID,
  wordId: w.id,
  listNo: Math.floor(i / 50) + 1,
  orderInList: i % 50,
  tier: (i % 4) + 1,
  tierUpdatedAt: iso(-10),
  status: 'active',
  created_at: iso(-30),
  streak: 0,
  failStreak: 0,
  specialTraining: i % 37 === 0,
  lastQuizAt: i % 5 === 0 ? iso(-1) : null,
  quiz_day_streak: 0,
  quiz_day_passed: false,
  quizDayStreak: 0,
  quizDayPassed: false,
  stage: i < Math.floor(words.length * 0.98) ? 1 : 2,
  stageStreak: i % 7 === 0 ? 1 : 0,
}));

export const studyPlans = [
  {
    id: PLAN_ID,
    bookId: BOOK_ID,
    userId: USER_ID,
    tierRounds: { 1: 2, 2: 2, 3: 3, 4: 3 },
    planMode: 'recommended',
    startDate: iso(-30).slice(0, 10),
    deadlineDate: '2026-12-05',
    sprintStartDate: '2026-12-05',
    dailyBudgetMin: 60,
    avgHitSec: 12,
    gapMinDays: 1,
    modalRatio: { 1: 0.7, 2: 0.5, 3: 0.3, 4: 0.2 },
    masteryDecayEnabled: true,
    tierRoundDays: undefined,
    version: 1,
    status: 'active',
    createdAt: iso(-30),
  },
];

/** 笔记：每 3 个词一条（便于 e2e 验证「有笔记=金黄高亮」的两种状态都能稳定覆盖） */
export const wordNotes = words
  .filter((_, i) => i % 3 === 0)
  .map((w, k) => ({
    id: `${USER_ID}_${w.id}`,
    userId: USER_ID,
    wordId: w.id,
    lemma: w.lemma,
    content: `e2e 笔记 ${k + 1}`,
    source: 'quiz:1',
    senseIndex: 0,
    createdAt: iso(-2),
    updatedAt: iso(-1),
  }));

export const hits = [];
export const feedbacks = [];
export const abilitySnapshots = [];
export const aiProposals = [];
export const ttsProviderConfigs = [];
export const aiProviderConfigs = [];

/** 表名 → 行数组（GET 时按表返回） */
export const tables = {
  books,
  book_words: bookWords,
  words,
  study_plans: studyPlans,
  word_notes: wordNotes,
  hits,
  feedbacks,
  ability_snapshots: abilitySnapshots,
  ai_proposals: aiProposals,
  tts_provider_configs: ttsProviderConfigs,
  ai_provider_configs: aiProviderConfigs,
  plan_rounds: [],
  plan_versions: [],
  training_items: [],
  training_records: [],
  pronunciation_logs: [],
  sessions: [],
  session_summaries: [],
  tool_call_logs: [],
  users: [{ id: USER_ID, email: 'e2e@test.local' }],
  word_bookmarks: [],
  word_examples: [],
  confusion_pairs: [],
  issues: [],
  mock_exam_records: [],
  mock_unlock_rules: [],
  tier_snapshots: [],
};
