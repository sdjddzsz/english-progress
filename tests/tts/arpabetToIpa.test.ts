/**
 * arpabetToIpa.test.ts —— T2 单测：§5.2 锚点词表 12 行逐条覆盖 + strip/split/isVowel。
 *
 * 锚点词表实现口径说明（与架构增量 §5.2 规则集的一致性核对，2026-10-13）：
 * 本实现严格按 §5.2 规则集正文（最大首辅音分点：音节核之间的辅音全部划归下一音节起首，
 * 不做语音学合法性检查；重音标记插在音节起首簇最左侧；同位置「先点后标记」；ER 一律→ɜr）。
 * 架构文档 §5.2 锚点词表中有若干行的示例值与其自身规则集不一致（academy / react / wilful /
 * comprehensive / annual / camera 等，多为手写词典 IPA 排版风格：混入长度符、省略音节点、
 * 把 ER 拆成 ə+r、把 D 归入前音节 coda 等），经判定为不可由规则集复现的示例值。
 * 本测试按规则集断言（下方逐行注明偏差），实现侧不迁就不可复现的示例值；
 * 偏差清单已回传架构师确认（架构师并行修订文档 §5.2 锚点表）。
 *
 * 规则集下 12 行权威期望值（供架构师对齐）：
 *   academy      /ə.ˈkæ.də.mi/
 *   bird         /ˈbɜrd/
 *   strength     /ˈstrɛŋθ/
 *   camera       /ˈkæ.mɜr.ə/
 *   react        /ri.ˈækt/
 *   wilful       /ˈwɪ.lfəl/
 *   eagle        /ˈi.ɡəl/
 *   comprehensive/ˌkɑ.mprə.ˈhɛ.nsɪv/
 *   annual       /ə.ˈnnæ.tʃɜr.əl/
 *   hello        /hə.ˈloʊ/
 *   progress     /ˈprɑ.ˌɡrɛs/
 *   ''/'   '     ''
 */
import { describe, expect, it } from 'vitest';
import { arpabetToIpa, isArpabetVowel, splitArpabetSyllables, stripArpabetStress } from '../../src/tts/arpabetToIpa';

describe('arpabetToIpa：锚点词表 12 行逐条覆盖', () => {
  it('academy：AH0→ə；主重音前移过起辅音 K；最大首辅音分点（D 归后音节起首）', () => {
    // 架构示例值 /əˈkæd.ə.mi/ 与其规则集（最大首辅音）不一致，按规则集取 /ə.ˈkæ.də.mi/
    expect(arpabetToIpa('AH0 K AE1 D AH0 M IY0')).toBe('/ə.ˈkæ.də.mi/');
  });

  it('bird：ER→ɜr；R 不省略', () => {
    expect(arpabetToIpa('B ER1 D')).toBe('/ˈbɜrd/');
  });

  it('strength：辅音簇起首；重音插簇前；单音节无点', () => {
    expect(arpabetToIpa('S T R EH1 NG TH')).toBe('/ˈstrɛŋθ/');
  });

  it('camera：多辅音全归后音节；ER0→ɜr（R 不省略）', () => {
    // 架构示例值 /ˈkæ.mə.rə/ 把 ER0 渲染成 ə 并凭空补一个 r，与规则 5（ER→ɜr）冲突；
    // 按规则集取 /ˈkæ.mɜr.ə/（M ER0 同属第二音节起首簇 + 音节核）。
    expect(arpabetToIpa('K AE1 M ER0 AH0')).toBe('/ˈkæ.mɜr.ə/');
  });

  it('react：元音相邻直接点分；IY0→i（先点后标记）', () => {
    // 架构示例值 /riˈækt/ 省略了点前标记，按规则集「先点后标记」取 /ri.ˈækt/
    expect(arpabetToIpa('R IY0 AE1 K T')).toBe('/ri.ˈækt/');
  });

  it('wilful：双写 L 保留；最大首辅音（LF 全归后音节）', () => {
    // 架构示例值 /ˈwɪl.fəl/ 把 L 归前音节，按规则集取 /ˈwɪ.lfəl/
    expect(arpabetToIpa('W IH1 L F AH0 L')).toBe('/ˈwɪ.lfəl/');
  });

  it('eagle：元音开头重音直接插元音前', () => {
    expect(arpabetToIpa('IY1 G AH0 L')).toBe('/ˈi.ɡəl/');
  });

  it('comprehensive：次重音 ˌ；MPR 归后；HH→h（音节点按规则集逐音节置）', () => {
    // 架构示例值 /ˌkɑmprəˈhɛnsɪv/ 完全省略音节点；按规则集最大首辅音取
    // /ˌkɑ.mprə.ˈhɛ.nsɪv/（N、S 两个辅音全归后音节起首）。
    expect(arpabetToIpa('K AA2 M P R AH0 HH EH1 N S IH0 V')).toBe('/ˌkɑ.mprə.ˈhɛ.nsɪv/');
  });

  it('annual：双写 N 保留；CH→tʃ；ER→ɜr', () => {
    // 架构示例值 /ənnˈætʃərəl/ 省略音节点且 ER→ər，按规则集取 /ə.ˈnnæ.tʃɜr.əl/
    // （ER0 是一个音节核、映射为 ɜr，不拆成 ə+r）。
    expect(arpabetToIpa('AH0 N N AE1 CH ER0 AH0 L')).toBe('/ə.ˈnnæ.tʃɜr.əl/');
  });

  it('hello：OW→oʊ', () => {
    expect(arpabetToIpa('HH AH0 L OW1')).toBe('/hə.ˈloʊ/');
  });

  it('progress：设置页试听探针展示值', () => {
    expect(arpabetToIpa('P R AA1 G R EH2 S')).toBe('/ˈprɑ.ˌɡrɛs/');
  });

  it('空串 / 空白串 → 空串', () => {
    expect(arpabetToIpa('')).toBe('');
    expect(arpabetToIpa('   ')).toBe('');
  });

  it('非法音素抛 Error（严格模式，调用方按未命中处理）', () => {
    expect(() => arpabetToIpa('XY1 Z')).toThrow('arpabetToIpa: invalid phoneme "XY1"');
    expect(() => arpabetToIpa('AE9')).toThrow('arpabetToIpa: invalid phoneme "AE9"');
    expect(() => arpabetToIpa('hello')).toThrow('arpabetToIpa: invalid phoneme "hello"');
  });
});

describe('arpabetToIpa：规则集细则', () => {
  it('AH 特殊规则：AH0→ə；AH1/AH2→ʌ；其余音素不因重音变形', () => {
    expect(arpabetToIpa('AH0')).toBe('/ə/');
    expect(arpabetToIpa('AH1')).toBe('/ˈʌ/'); // 音质 ʌ + 主重音标记（规则 2 与规则 3 叠加）
    expect(arpabetToIpa('AH2')).toBe('/ˌʌ/'); // 音质 ʌ + 次重音标记
    expect(arpabetToIpa('IY0 IY1')).toBe('/i.ˈi/'); // IY 不因重音变形
  });

  it('重音 2 → ˌ；重音 0 无标记', () => {
    expect(arpabetToIpa('K AA2 M P R AH0 HH EH1 N S IH0 V')).toContain('ˌ');
    expect(arpabetToIpa('K AE1 T')).toBe('/ˈkæt/'); // 尾部无点
  });

  it('单音节词无点；无重音数字按 0 处理', () => {
    expect(arpabetToIpa('K AE T')).toBe('/kæt/');
    expect(arpabetToIpa('S T R EH NG TH')).toBe('/strɛŋθ/');
  });

  it('输入前后空白容忍；多空格按单空格切分', () => {
    expect(arpabetToIpa('  B  ER1   D  ')).toBe('/ˈbɜrd/');
  });
});

describe('stripArpabetStress', () => {
  it('去重音数字', () => {
    expect(stripArpabetStress('AH0 K AE1 D AH0 M IY0')).toBe('AH K AE D AH M IY');
    expect(stripArpabetStress('AH0 K AE1 D')).toBe('AH K AE D');
  });

  it('无数字原样；空串/空白 → 空串', () => {
    expect(stripArpabetStress('AH K AE D')).toBe('AH K AE D');
    expect(stripArpabetStress('')).toBe('');
    expect(stripArpabetStress('  ')).toBe('');
  });
});

describe('splitArpabetSyllables', () => {
  it('最大首辅音边界（与 IPA 音节点同一套规则）', () => {
    expect(splitArpabetSyllables('AH0 K AE1 D AH0 M IY0')).toEqual(['AH0', 'K AE1', 'D AH0', 'M IY0']);
    expect(splitArpabetSyllables('K AE1 M ER0 AH0')).toEqual(['K AE1', 'M ER0', 'AH0']);
    expect(splitArpabetSyllables('R IY0 AE1 K T')).toEqual(['R IY0', 'AE1 K T']);
  });

  it('单音节词返回单元素数组；空串返回 []', () => {
    expect(splitArpabetSyllables('B ER1 D')).toEqual(['B ER1 D']);
    expect(splitArpabetSyllables('')).toEqual([]);
  });

  it('元音开头音节自成一段', () => {
    expect(splitArpabetSyllables('IY1 G AH0 L')).toEqual(['IY1', 'G AH0 L']);
  });
});

describe('isArpabetVowel', () => {
  it('元音集合判断（接受带/不带重音数字）', () => {
    expect(isArpabetVowel('AE1')).toBe(true);
    expect(isArpabetVowel('AH0')).toBe(true);
    expect(isArpabetVowel('IY')).toBe(true);
    expect(isArpabetVowel('ER2')).toBe(true);
    expect(isArpabetVowel('K')).toBe(false);
    expect(isArpabetVowel('CH')).toBe(false);
    expect(isArpabetVowel('NG')).toBe(false);
  });
});
