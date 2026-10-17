/* ============================================================
   sim.mjs — 离线通道（仅在 AI_PLATFORM_PROVIDER=sim 或没有 API Key 时使用）
   它不编造统计数字：只生成真实的模板代码/文档，交给 exec.mjs 真跑。
   界面与事件流会标明当前走的是离线通道还是真实模型。
   源码目录：与真实模型通道同一套规约（直接落在レイヤーディレクトリ src/<层>/，文件名用业务语义、不带 WBS 序号，也不建模块子目录），
   层清单由本通道的 ARC-01 用同一个 json 代码块声明，走同一条解析路径。
   ============================================================ */
import { DEFAULT_LAYERS, srcFileOf, testFileOf, modDirOf, testPathOf } from './agent.mjs';
import { profileOf } from './exec.mjs';

export function hash(s) { let h = 2166136261; for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

export function planSteps(project, stage) {
  const base = {
    requirements: ['プロジェクト概要を確認', 'ユーザーと利用場面を整理', '機能要件を分解', '業務ルールと例外を定義', '受入基準を作成'],
    ux: ['情報構造を設計', 'ナビゲーションと画面一覧を設計', '画面仕様を定義', '共通テンプレートと画面プロトタイプを準備'],
    architecture: ['システム境界とレイヤーを設計', 'データモデルを設計', 'API 契約を定義'],
    wbs: ['要件と成果物を対応付け', '結合度に基づきエピックを分割', 'タスクとファイルの担当を割り当て'],
    testing: ['ワークスペースのテスト結果を集計', 'カバレッジと不足を集計'],
    deployment: ['ビルド検証', 'スモークテスト'],
    operations: ['メトリクスとログを設定', 'アラートしきい値を設定'],
  }[stage.id] || ['エージェントタスクを実行'];
  return base.map((text, i) => ({ text: `${stage.agent} · ${text}`, ms: 200 + (hash(stage.id + i) % 4) * 100 }));
}

/* ---------- UX プロトタイプ（離線：決定的。モデル通道と同じ形を返す） ---------- */

/** デザインシステム：既定トークン + 既定ファンクションキー（project 名だけ反映）。 */
export function uxDesign(project) {
  return { system: String(project.name || '業務システム').slice(0, 20), tokens: {}, fkeys: [] };
}

/** 重要画面のハイファイ内容：抽出項目はそのまま、件数・ガイダンス・状態注記を決定的に足す。 */
export function uxHifi(project, scr, base) {
  return {
    search: base.search, columns: base.columns, detail: base.detail,
    rows: 6 + (hash(scr.id) % 5),
    message: scr.form === 'report' ? '出力条件を入力して F9（印刷）を押してください。' : '検索条件を入力して F2（検索）を押してください。',
    notes: ['状態：0 件時は「該当データがありません」を一覧に表示', '権限なし時は F5（登録）を非活性'],
  };
}

/* ---------- 文档产物（离线模板） ---------- */

export function planArtifacts(project, stage) {
  const t = project.tech || 'Node.js';
  const body = {
    requirements: [['REQ-01', '要件定義書'], ['US-01', 'ユーザーストーリー集'], ['AC-01', '受入基準']],
    ux: [['UX-01', '情報構造とナビゲーション'], ['UX-02', '画面プロトタイプ仕様']],
    architecture: [['ARC-01', 'アーキテクチャ設計書'], ['ARC-02', 'データモデル設計'], ['ARC-03', 'API 仕様']],
    operations: [['SRE-01', '監視・アラート計画'], ['SRE-02', '運用手順書']],
  }[stage.id] || [['DOC-01', 'ステージ成果物']];
  return body.map(([id, name]) => ({
    id, name, type: 'markdown', status: 'generated',
    content: `# ${name} · ${project.name}

> オフラインテンプレート（sim）の構成例です。API Key を設定すると、実モデルが本文を生成します。

## 概要
${project.brief || '（未指定）'}

## 技術スタック
${t}

## 項目
- このステージで必要な成果物を網羅する
- 各項目に検証可能な受入方法を対応付ける
` + (id === 'ARC-01' ? layoutSection(project) : ''),
  }));
}

/** ARC-01 的「源码目录结构」一节：模块生成按这里声明的层归档（与真实模型同一份格式）。
    离线通道也要跟用户填的技術スタック一致 —— 否则会出现「技术方案写 Java、产物却是 .mjs」的错位。 */
const STACK_LABEL = {
  node: 'Node.js ESM + node:test（サードパーティ依存なし）',
  python: 'Python 3 + 標準ライブラリ unittest（サードパーティ依存なし）',
  java: 'Java 21 + Spring Boot 3.3 レイヤー構造（javac/java 実際にコンパイル・実行；サードパーティ依存なし）',
  'cap-java': 'SAP CAP Java（CDS + Java，javac/java 実際にコンパイル・実行；CDS は構造を検証）',
  'cap-node': 'SAP CAP Node.js（CDS + Node.js ESM，node --test）',
  'ts-node': 'Next.js + NestJS + PostgreSQL 16（TypeScript · npm 許可リスト依存 · tsx + node --test · PostgreSQL は Docker で統合テスト）',
};
const layoutSection = (project) => {
  const pro = profileOf(project.arch?.stack || project.tech || '');
  const dirEx = pro.modDir('domain', 'm2-business-rules');
  const testEx = pro.testPath('domain', 'm2-business-rules', 'M2');
  const cdsLine = pro.cds ? `\nデータモデルとサービス定義は CDS で記述（\`db/schema.cds\`、\`srv/<名>-service.cds\`），各エンティティに必要： \`key\`。\n` : '';
  return `
## ソースディレクトリ構造（規約）

1 エピックを 1 開発モジュールとし、ソースと単体テストをレイヤーごとに対応させます。

| レイヤーディレクトリ | 責務 |
|---|---|
| \`src/core/\` | ドメインモデルと純粋関数 |
| \`src/domain/\` | 業務ルールと状態遷移 |
| \`src/service/\` | ユースケースの調整 |
| \`src/api/\` | API アダプターと DTO |

ソースの配置先： \`${dirEx}/\`（例）。テストの配置先： \`${testEx}\`。${cdsLine}
\`\`\`json
{"stack":"${STACK_LABEL[pro.id]}","layers":[{"dir":"core","responsibility":"ドメインモデルと純粋関数"},{"dir":"domain","responsibility":"業務ルールと状態遷移"},{"dir":"service","responsibility":"ユースケースの調整"},{"dir":"api","responsibility":"API アダプターと DTO"}]}
\`\`\`
`;
};

// 依存グラフの見本：E3 は E1・E2 に、E4 は E3 に依存。E1・E2・E5 は独立なので並行に着手できる。
const SIM_DEPS = [[], [], ['E1', 'E2'], ['E3'], []];

export function planWbs(project) {
  const ls = (project.arch && project.arch.layers && project.arch.layers.length) ? project.arch.layers : DEFAULT_LAYERS;
  // 要件台帳の ID を各 Epic に順番に割り当てる（オフラインでも網羅率 100% のトレースになる）
  const ids = ((project.ledger && project.ledger.items) || []).filter(it => !it.parent).map(it => it.id);
  const reqOf = (i) => ids.filter((_, k) => k % 5 === i);
  const epics = ['Core utilities', 'Data models', 'Business logic', 'API adapters', 'Quality and delivery'].map((name, i) => ({
    id: `E${i + 1}`, name, layer: ls[i % ls.length], goal: `${name}：単体テスト可能な純粋関数モジュールを提供`,
    deps: SIM_DEPS[i], req_ids: reqOf(i),
    tasks: ['主要関数を実装', '境界条件を処理'].map((t, j) => ({
      id: `E${i + 1}-T${j + 1}`, name: `${name} ${t}`,
      files: `src/${ls[i % ls.length]}/<business-name>.mjs`, acceptance: `タスク「${name} ${t}」の単体テストがすべて成功する`, status: 'todo',
    })),
  }));
  return { epics, task_count: epics.reduce((a, e) => a + e.tasks.length, 0), layers: ls, generated_at: new Date().toISOString() };
}

/* ---------- 模块代码（真实可运行的 ESM + 真单测） ---------- */

const SRC = `/** オフライン生成のテンプレート：純粋関数、依存なし、単体テスト可能。 */
export function slugify(input) {
  return String(input).trim().toLowerCase().replace(/[^a-z0-9\\u4e00-\\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
}

export function clamp(n, min, max) {
  const v = Number(n);
  if (Number.isNaN(v)) throw new TypeError('n must be a number');
  return Math.min(Math.max(v, min), max);
}

export function summarize(list) {
  const arr = Array.isArray(list) ? list : [];
  return { count: arr.length, first: arr.length ? arr[0] : null, last: arr.length ? arr[arr.length - 1] : null };
}

export function groupBy(list, keyFn) {
  return (Array.isArray(list) ? list : []).reduce((acc, item) => {
    const k = String(keyFn(item));
    (acc[k] ||= []).push(item);
    return acc;
  }, {});
}
`;

const TEST = (dir, moduleName, srcFile = 'core.mjs') => `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, clamp, summarize, groupBy } from '../../${dir}/${srcFile}';

// モジュール：${moduleName}

test('slugify normalizes and collapses separators', () => {
  assert.equal(slugify('  Hello World  '), 'hello-world');
  assert.equal(slugify('A__B  C'), 'a-b-c');
});

test('clamp returns the input inside bounds and clamps outside', () => {
  assert.equal(clamp(5, 1, 10), 5);
  assert.equal(clamp(-3, 0, 8), 0);
  assert.equal(clamp(99, 0, 8), 8);
});

test('clamp rejects non-numeric input with TypeError', () => {
  assert.throws(() => clamp('abc', 0, 1), TypeError);
});

test('summarize returns first, last and count', () => {
  assert.deepEqual(summarize(['a', 'b', 'c']), { count: 3, first: 'a', last: 'c' });
  assert.deepEqual(summarize([]), { count: 0, first: null, last: null });
});

test('groupBy groups by key', () => {
  const r = groupBy([1, 2, 3, 4], (n) => (n % 2 === 0 ? 'even' : 'odd'));
  assert.deepEqual(r, { odd: [1, 3], even: [2, 4] });
});

test('groupBy returns an empty object for non-array input', () => {
  assert.deepEqual(groupBy(null, String), {});
});
`;

/* TypeScript 档案（NestJS / PostgreSQL）：Repository インターフェース + InMemory 実装 + pg 実装、Service はインターフェースだけに依存。 */
const TS_SRC = (name) => `/** オフラインテンプレート：${name}（Repository 層経由で DB にアクセス） */
import 'reflect-metadata';
import { Injectable } from '@nestjs/common';

export interface Item { id: string; name: string; qty: number }

export interface ItemRepository {
  findById(id: string): Promise<Item | null>;
  save(item: Item): Promise<void>;
}

export class InMemoryItemRepository implements ItemRepository {
  private readonly rows = new Map<string, Item>();
  async findById(id: string): Promise<Item | null> { return this.rows.get(id) ?? null; }
  async save(item: Item): Promise<void> { this.rows.set(item.id, { ...item }); }
}

/** PostgreSQL 実装：pg の Pool 互換オブジェクトを注入（パラメータ化 SQL のみ）。 */
export class PgItemRepository implements ItemRepository {
  constructor(private readonly pool: { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> }) {}
  async init(): Promise<void> { await this.pool.query('CREATE TABLE IF NOT EXISTS items (id text PRIMARY KEY, name text NOT NULL, qty integer NOT NULL)'); }
  async findById(id: string): Promise<Item | null> {
    const r = await this.pool.query('SELECT id, name, qty FROM items WHERE id = $1', [id]);
    return r.rows[0] ?? null;
  }
  async save(item: Item): Promise<void> {
    await this.pool.query('INSERT INTO items (id, name, qty) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = $2, qty = $3', [item.id, item.name, item.qty]);
  }
}

@Injectable()
export class ItemService {
  constructor(private readonly repo: ItemRepository) {}
  async adjust(id: string, delta: number): Promise<Item> {
    const cur = await this.repo.findById(id);
    if (!cur) throw new Error(\`item not found: \${id}\`);
    if (cur.qty + delta < 0) throw new RangeError('qty must not go negative');
    const next = { ...cur, qty: cur.qty + delta };
    await this.repo.save(next);
    return next;
  }
}
`;

const TS_TEST = (dir, moduleName, base) => `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ItemService, InMemoryItemRepository, PgItemRepository } from '../../${dir}/${base}';

// モジュール：${moduleName}

test('adjust adds delta through the repository', async () => {
  const repo = new InMemoryItemRepository();
  await repo.save({ id: 'A', name: 'bolt', qty: 3 });
  assert.deepEqual(await new ItemService(repo).adjust('A', 2), { id: 'A', name: 'bolt', qty: 5 });
  assert.equal((await repo.findById('A'))?.qty, 5);
});

test('adjust rejects negative stock and unknown ids', async () => {
  const repo = new InMemoryItemRepository();
  await repo.save({ id: 'A', name: 'bolt', qty: 1 });
  await assert.rejects(() => new ItemService(repo).adjust('A', -2), RangeError);
  await assert.rejects(() => new ItemService(repo).adjust('Z', 1), /item not found: Z/);
});

test('PgItemRepository round-trips against PostgreSQL', { skip: !process.env.DATABASE_URL && 'PostgreSQL unavailable' }, async () => {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const repo = new PgItemRepository(pool);
    await repo.init();
    await repo.save({ id: 'pg-1', name: 'nut', qty: 7 });
    assert.deepEqual(await repo.findById('pg-1'), { id: 'pg-1', name: 'nut', qty: 7 });
  } finally { await pool.end(); }
});
`;

const JAVA_SRC = (name, cls) => `import java.util.ArrayList;
import java.util.List;

/** オフラインテンプレートモジュール：${name} */
public class ${cls} {
  public static int clamp(int v, int lo, int hi) {
    if (lo > hi) throw new IllegalArgumentException("lo > hi");
    return v < lo ? lo : (v > hi ? hi : v);
  }

  public static List<Integer> evens(List<Integer> xs) {
    List<Integer> out = new ArrayList<>();
    for (int x : xs) if (x % 2 == 0) out.add(x);
    return out;
  }
}
`;

const JAVA_TEST = (name, cls) => `import java.util.Arrays;

// モジュール：${name}
public class ${cls}Test {
  static int pass = 0, fail = 0;
  static void check(String name, boolean ok) { if (ok) pass++; else { fail++; System.out.println("not ok - " + name); } }

  public static void main(String[] args) {
    check("clamp preserves input within bounds", ${cls}.clamp(5, 1, 10) == 5);
    check("clamp returns lower bound below range", ${cls}.clamp(-3, 0, 8) == 0);
    check("clamp returns upper bound above range", ${cls}.clamp(99, 0, 8) == 8);
    check("evens retains even numbers", ${cls}.evens(Arrays.asList(1, 2, 3, 4)).equals(Arrays.asList(2, 4)));
    System.out.println("tests " + (pass + fail));
    System.out.println("pass " + pass);
    System.out.println("fail " + fail);
    System.exit(fail == 0 ? 0 : 1);
  }
}
`;

const PY_SRC = (name) => `"""オフラインテンプレートモジュール：${name}"""


def clamp(v, lo, hi):
    if lo > hi:
        raise ValueError("lo > hi")
    return lo if v < lo else (hi if v > hi else v)


def evens(xs):
    return [x for x in xs if x % 2 == 0]
`;

const PY_TEST = (name, dir, pyName = 'core') => `import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '${dir}'))
from ${pyName} import clamp, evens


class TestCore(unittest.TestCase):
    # モジュール：${name}
    def test_clamp(self):
        self.assertEqual(clamp(5, 1, 10), 5)
        self.assertEqual(clamp(-3, 0, 8), 0)
        self.assertEqual(clamp(99, 0, 8), 8)

    def test_clamp_lo_gt_hi(self):
        with self.assertRaises(ValueError):
            clamp(1, 5, 0)

    def test_evens(self):
        self.assertEqual(evens([1, 2, 3, 4]), [2, 4])


if __name__ == '__main__':
    unittest.main()
`;

/** SAP CAP 的 CDS Data models（离线模板也是真实文件 + 構造検証；没有 cds-dk 不假装编译）。 */
export const CDS_SCHEMA = `namespace order.manage;

entity Orders {
  key ID        : UUID;
  orderNo       : String(20);
  amount        : Decimal(15, 2);
  status        : String(10);
  createdAt     : Timestamp;
}
`;

export const CDS_SERVICE = `namespace order.manage;

using { Orders } from '../db/schema';

service OrderService {
  entity Orders as projection on order.manage.Orders;
}
`;

/** オフライン疑問：担当 ID の名前に「未定 / TBD / 要確認」があれば、回答済みでない限り人に確認する（疑問・変更台帳の動作確認用）。 */
export function simQuestions(project, mod) {
  const answered = new Set((project.questions || []).filter(q => q.status === 'answered').flatMap(q => q.req_ids || []));
  const items = ((project.ledger && project.ledger.items) || []).filter(it => (mod.req_ids || []).includes(it.id));
  return items.filter(it => /未定|TBD|要確認/i.test(it.name || '') && !answered.has(it.id))
    .map(it => ({ req_ids: [it.id], text: `${it.id}「${it.name}」の仕様が未確定です。どう実装すべきか決めてください。` }));
}

export function moduleCode(project, mod) {
  return { ...templateCode(project, mod), questions: simQuestions(project, mod) };
}

function templateCode(project, mod) {
  // 目录由 harness 按架构规约算好（mod.dir / mod.test_path_planned），这里只照写。
  const profile = profileOf((project.arch && project.arch.stack) || project.tech || '');
  const layer = mod.layer || 'core';
  const dir = mod.dir || profile.modDir(layer);                       // レイヤーディレクトリ（没有模块子目录）
  const srcFile = srcFileOf(profile, mod.name);                        // 业务文件名（不带 WBS 号）
  const cls = srcFile.replace(/\.[a-z]+$/, '');                        // Java 类名 = 文件名
  const testPath = mod.test_path_planned || profile.testPath(layer, testFileOf(profile, mod.name));
  const cds = profile.cds ? [
    { path: 'db/schema.cds', content: CDS_SCHEMA },
    { path: 'srv/order-service.cds', content: CDS_SERVICE },
  ] : [];
  if (profile.id === 'java' || profile.id === 'cap-java') return {
    summary: `オフラインテンプレートモジュール（Java · ${mod.name}）`,
    files: [{ path: `${dir}/${srcFile}`, content: JAVA_SRC(mod.name, cls) }, ...cds],
    test: { path: testPath, content: JAVA_TEST(mod.name, cls) },
  };
  if (profile.id === 'ts-node') return {
    summary: `オフラインテンプレートモジュール（TypeScript · NestJS / PostgreSQL · ${mod.name}）`,
    files: [{ path: `${dir}/${srcFile}`, content: TS_SRC(mod.name) }],
    test: { path: testPath, content: TS_TEST(dir, mod.name, cls) },
    deps: ['pg', '@types/pg'],
  };
  if (profile.id === 'python') return {
    summary: `オフラインテンプレートモジュール（Python · ${mod.name}）`,
    files: [{ path: `${dir}/${srcFile}`, content: PY_SRC(mod.name) }, ...cds],
    test: { path: testPath, content: PY_TEST(mod.name, dir, cls) },
  };
  return {
    summary: `オフラインテンプレートモジュール（${mod.name}）`,
    files: [{ path: `${dir}/${srcFile}`, content: SRC }, ...cds],
    test: { path: testPath, content: TEST(dir, mod.name, srcFile) },
  };
}
