/* ============================================================
   exec.test.mjs — 真实执行（node --test / javac / cds）
   运行：AI_PLATFORM_SPEED=0 node --test test/exec.test.mjs
   注：本文件 6 件の失敗（2026-10-17 棚卸し時点）は **すべて JDK 必須 or cds 必須**。
   テスト正本の修正は不要で、Mac に JDK 17 を入れるか colima 経由で cds を有効化すれば緑になる。
   詳細は docs/test-triage-2026-10-17.md「環境依存」節。
   ============================================================ */
/* exec 多语言执行层：栈档案识别 + 真跑 javac/java、python3、node --test（不是模拟输出） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const exec = await import('../exec.mjs');
const A = await import('../agent.mjs');       // 业务命名助手（srcFileOf / testFileOf）

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `aipf-${tag}-`));

test('测试进程挂住不会挂住流水线：硬超时到点杀进程组，如实报超时（不是假绿也不卡死）', async () => {
  const root = tmp('hang');
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test', 'hang.test.mjs'),
    "import { test } from 'node:test';\ntest('永远不返回', async () => { await new Promise(() => {}); });\n");
  process.env.AI_PLATFORM_TEST_TIMEOUT_MS = '1500';
  const t0 = Date.now();
  const r = await exec.runTests(root, 'test/hang.test.mjs', exec.PROFILES.node);
  const secs = (Date.now() - t0) / 1000;
  delete process.env.AI_PLATFORM_TEST_TIMEOUT_MS;
  assert.ok(secs < 10, `1.5s 超时后应很快返回（实际 ${secs.toFixed(1)}s —— 卡住说明还有子孙进程攥着管道）`);
  assert.equal(r.timed_out, true, `要标成超时：exit=${r.exit_code} tail=${JSON.stringify((r.tail || '').slice(-90))}`);
  assert.equal(r.ok, false, '超时绝不能算通过');
  assert.match(r.tail, /进程组已强制结束/, '输出里写清超时已强制结束');
});

test('栈档案：技术栈文本 → 语言与路径规约', () => {
  assert.equal(exec.profileOf('Java 21 + Spring Boot 3.3 + PostgreSQL 16').id, 'java');
  assert.equal(exec.profileOf('java springboot').id, 'java');
  assert.equal(exec.profileOf('Java Struts2 + JDBC').id, 'java');
  assert.equal(exec.profileOf('SAP CAP Java').id, 'cap-java');
  assert.equal(exec.profileOf('SAP CAP Node.js').id, 'cap-node');
  assert.equal(exec.profileOf('SAP CAP (CDS + Node.js ESM) + ABAP RAP + Java Spring Boot 3, DB: SAP HANA / SQLite(dev), Test: node:test').id, 'cap-java', 'CAP 里同时提 Java 与 Node 时按 Java（交付规约里的 Node 只是提法）');
  assert.equal(exec.profileOf('SAP CAP + ABAP + Java / 零依赖 Node ESM 交付规约').id, 'cap-java');
  assert.equal(exec.profileOf('Python 3.12 + FastAPI').id, 'python');
  assert.equal(exec.profileOf('Node.js 22 + React').id, 'node');
  // 「JavaScript / JS / 静态站」里也含 java 四个字母——别判成 Java（线上就是这么把 js,html 项目写成 .java 的）
  assert.equal(exec.profileOf('js， html').id, 'node', 'JS/HTML 静态站 = Node 档案');
  assert.equal(exec.profileOf('HTML5 + CSS3 + 原生 JavaScript（ES Modules）静态站点').id, 'node', '「JavaScript」里的 java 不算 Java');
  assert.equal(exec.profileOf('React + Vite + TypeScript 静态站').id, 'node');
  assert.equal(exec.profileOf('SAP CAP + JavaScript').id, 'cap-node', 'CAP + JS 是 CAP Node，不是 CAP Java');
  assert.equal(exec.profileOf('JavaScript 前端 + Java Spring Boot 后端').id, 'java', '真同时有 Java 后端时按 Java');
  assert.equal(exec.profileOf('').id, 'node', '判不出就回落 Node');
  assert.ok(exec.profileOf('SAP CAP Java').cds, 'CAP 栈要产出 CDS');
  assert.ok(!exec.profileOf('Java 21 + Spring Boot').cds, '非 CAP 不产 CDS');
  const j = exec.profileOf('Spring Boot');
  assert.equal(j.testPath('domain', 'OrderServiceTest.java'), 'src/test/java/domain/OrderServiceTest.java', 'Java 测试按 Maven 目录规约');
  assert.equal(j.modDir('domain'), 'src/main/java/domain', '层目录直落，不再有 m1-xxx 模块子目录');
  assert.equal(exec.profileOf('Node.js').modDir('service'), 'src/service');
  assert.equal(exec.profileOf('Node.js').testPath('service', 'order-service.test.mjs'), 'test/service/order-service.test.mjs');
  // 业务语义命名：文件名不带 WBS 序号（M1OrderService / m1_order_service 这类一律不生成）
  const node = exec.profileOf('Node.js'), py = exec.profileOf('Python'), jv = exec.profileOf('Spring Boot');
  assert.equal(A.srcFileOf(node, '订单服务'), '订单服务.mjs', 'Node：业务名 kebab/CJK');
  assert.equal(A.srcFileOf(node, 'Order Refund Service'), 'order-refund-service.mjs');
  assert.equal(A.srcFileOf(py, 'Order Refund Service'), 'order_refund_service.py', 'Python：snake_case');
  assert.equal(A.srcFileOf(jv, 'order refund service'), 'OrderRefundService.java', 'Java：PascalCase，文件名 = 类名');
  assert.equal(A.testFileOf(jv, 'order refund service'), 'OrderRefundServiceTest.java');
  assert.equal(A.testFileOf(node, 'order refund service'), 'order-refund-service.test.mjs');
  assert.ok(!/^m?\d/i.test(A.srcFileOf(jv, '订单服务')), '生成的业务文件名不带 WBS 序号前缀');
});

test('真实跑 Java：javac 编译 + java 执行测试类；断言失败时 ok=false、退出码非 0', async () => {
  const root = tmp('java');
  const src = `public class M1Amount { public static int add(int a, int b) { return a + b; } }`;   // Java：文件名 = 类名 = 模块号前缀
  const mkTest = (bad) => `public class M1Test {
  static int pass = 0, fail = 0;
  static void check(String n, boolean ok) { if (ok) pass++; else { fail++; System.out.println("not ok - " + n); } }
  public static void main(String[] a) {
    check("1+1=2", M1Amount.add(1, 1) == ${bad ? 3 : 2});
    check("2+3=5", M1Amount.add(2, 3) == 5);
    System.out.println("tests " + (pass + fail));
    System.out.println("pass " + pass);
    System.out.println("fail " + fail);
    System.exit(fail == 0 ? 0 : 1);
  }
}`;
  exec.writeFiles(root, [
    { path: 'src/main/java/domain/M1Amount.java', content: src },
    { path: 'src/test/java/domain/M1Test.java', content: mkTest(false) },
  ]);
  const ok = await exec.runJava(root, 'src/test/java/domain/M1Test.java');
  assert.ok(ok.ok, `应真实通过：${ok.tail}`);
  assert.equal(ok.exit_code, 0);
  assert.equal(ok.total, 2);
  assert.equal(ok.passed, 2);
  assert.equal(ok.failed, 0);
  assert.match(ok.cmd, /^javac -d \.build/, '记录的是真跑命令');

  fs.writeFileSync(path.join(root, 'src/test/java/domain/M1Test.java'), mkTest(true));
  const bad = await exec.runJava(root, 'src/test/java/domain/M1Test.java');
  assert.equal(bad.ok, false);
  assert.equal(bad.exit_code, 1, '断言失败必须真非 0');
  assert.equal(bad.failed, 1);
  assert.match(bad.tail, /not ok - 1\+1=2/);
});

test('真实跑 Java：编译不过就报编译失败（不假装测试跑了）', async () => {
  const root = tmp('java-broken');
  exec.writeFiles(root, [
    { path: 'src/main/java/x/Broken.java', content: 'public class Broken { oops }' },
    { path: 'src/test/java/x/M1Test.java', content: 'public class M1Test { public static void main(String[] a) {} }' },
  ]);
  const r = await exec.runJava(root, 'src/test/java/x/M1Test.java');
  assert.equal(r.ok, false);
  assert.notEqual(r.exit_code, 0);
  assert.match(r.tail, /编译失败/);
});

test('缺 JDK 时明确失败，绝不静默退回 Node；自举会先试一次安装', async () => {
  const root = tmp('no-jdk');
  exec.writeFiles(root, [{ path: 'src/main/java/x/A.java', content: 'public class A {}' }]);
  process.env.AI_PLATFORM_NO_JDK = '1';
  process.env.AI_PLATFORM_NO_INSTALL = '1';                   // 模拟「机器上没 JDK，也装不上」
  try {
    const r = await exec.runJava(root, 'src/test/java/x/M1Test.java');
    assert.equal(r.ok, false);
    assert.equal(r.exit_code, -1);
    assert.match(r.tail, /缺 JDK/);
    assert.match(r.cmd, /未找到/);
  } finally { delete process.env.AI_PLATFORM_NO_JDK; delete process.env.AI_PLATFORM_NO_INSTALL; }
});

test('环境自举：缺工具链就装一次再重探，装不上如实失败、已有则不动', async () => {
  const dir = tmp('boot'), marker = path.join(dir, 'installed');
  const plan = ['sh', '-c', `touch ${marker}`];                // 假安装器：只留痕，不碰真机
  let hasIt = false;
  const probe = () => (hasIt ? { javac: '/x/javac', java: '/x/java' } : null);

  const r = await exec.ensureToolchain('java', { probe, plan });
  assert.ok(fs.existsSync(marker), '真去执行了安装命令');
  assert.equal(r.code, 0);
  assert.equal(r.ok, false, '装完重探还是没有 → ok:false（不假装成功）');
  assert.match(r.cmd, /touch/, '把执行过的命令带回来，失败原因里要能写清');
  assert.ok(exec.installPlan('java') === null || exec.installPlan('java').length >= 2, '安装计划是可执行命令');

  hasIt = true;
  assert.equal(await exec.ensureToolchain('java', { probe, plan }), null, '已有工具链 → 什么都不做');

  process.env.AI_PLATFORM_NO_INSTALL = '1';
  try { assert.equal(await exec.ensureToolchain('java', { probe: () => null, plan }), null, '关掉自举 → 不装'); }
  finally { delete process.env.AI_PLATFORM_NO_INSTALL; }

  process.env.AI_PLATFORM_INSTALL_CMD = 'echo 自定义安装器';
  try { assert.deepEqual(exec.installPlan('python'), ['sh', '-c', 'echo 自定义安装器'], '可用自定义安装通道替换'); }
  finally { delete process.env.AI_PLATFORM_INSTALL_CMD; }
});

test('Java 模块级执行只编本模块：别的层同名类不再把每个模块都拖红', async () => {
  const root = tmp('java-dup');
  const testFile = 'src/test/java/core/CoreTest.java';
  exec.writeFiles(root, [
    { path: 'src/main/java/core/Order.java', content: 'public class Order { public static String id() { return "SO-1"; } }\n' },
    { path: 'src/main/java/api/Order.java', content: 'public class Order { public static String id() { return "API-1"; } }\n' },   // 无 package 单 classpath：同名 = 整个工作区编译失败
    { path: testFile, content: 'public class CoreTest {\n  static int pass = 0, fail = 0;\n  static void check(String n, boolean ok) { if (ok) pass++; else { fail++; System.out.println("not ok " + n); } }\n  public static void main(String[] a) {\n    check("本层的 Order.id()", "SO-1".equals(Order.id()));\n    System.out.println("tests " + (pass + fail)); System.out.println("pass " + pass); System.out.println("fail " + fail);\n    System.exit(fail == 0 ? 0 : 1);\n  }\n}\n' },
  ]);
  const scoped = await exec.runJava(root, testFile, ['src/main/java/core/Order.java', testFile]);
  assert.equal(scoped.ok, true, `只编本模块应当真跑通：${scoped.tail}`);
  assert.equal(scoped.total, 1);
  assert.match(scoped.cmd, /本模块/, `命令里写明编译范围：${scoped.cmd}`);

  const whole = await exec.runJava(root, testFile);                       // 不传 ownFiles = 集成口径：全工作区
  assert.equal(whole.ok, false);
  assert.equal(whole.exit_code, 1);
  assert.match(whole.tail, /重複|duplicate/i, `全工作区编译必须报类名重复：${whole.tail.slice(-200)}`);
  assert.match(whole.cmd, /全工作区/);
});

test('真实跑 Python：unittest 通过/失败都被识别', async () => {
  const root = tmp('py');
  const mkTest = (bad) => `import sys, os, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from src.service.calc import add

class T(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(1, 1), ${bad ? 3 : 2})

if __name__ == '__main__':
    unittest.main()
`;
  exec.writeFiles(root, [
    { path: 'src/service/calc.py', content: 'def add(a, b):\n    return a + b\n' },
    { path: 'test/service/calc.test.py', content: mkTest(false) },
  ]);
  const ok = await exec.runPython(root, 'test/service/calc.test.py');
  assert.ok(ok.ok, `应真实通过：${ok.tail}`);
  assert.equal(ok.total, 1);
  assert.equal(ok.passed, 1);
  assert.equal(ok.failed, 0);
  assert.match(ok.cmd, /^python3 test\/service\/calc\.test\.py$/);

  fs.writeFileSync(path.join(root, 'test/service/calc.test.py'), mkTest(true));
  const bad = await exec.runPython(root, 'test/service/calc.test.py');
  assert.equal(bad.ok, false);
  assert.equal(bad.failed, 1);
  assert.equal(bad.exit_code, 1);
});

test('工作区整体测试：混合语言产物都真的跑一遍', async () => {
  const root = tmp('mixed');
  exec.writeFiles(root, [
    { path: 'src/main/java/domain/A.java', content: 'public class A { public static int one() { return 1; } }' },
    { path: 'src/test/java/domain/M1Test.java', content: 'public class M1Test { public static void main(String[] a) { System.out.println("tests 1"); System.out.println("pass " + (A.one() == 1 ? 1 : 0)); System.out.println("fail " + (A.one() == 1 ? 0 : 1)); if (A.one() != 1) System.exit(1); } }' },
    { path: 'src/service/calc.py', content: 'def add(a, b):\n    return a + b\n' },
    { path: 'test/service/calc.test.py', content: 'import sys, os, unittest\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))\nfrom src.service.calc import add\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 2), 4)\nif __name__ == "__main__":\n    unittest.main()\n' },
    { path: 'src/core/util.mjs', content: 'export const one = () => 1;\n' },
    { path: 'test/core/util.test.mjs', content: 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { one } from "../../src/core/util.mjs";\ntest("one", () => assert.equal(one(), 1));\n' },
  ]);
  const r = await exec.runWorkspaceTests(root);
  assert.ok(r.ok, `三种语言都该通过：${r.tail}`);
  assert.equal(r.total, 3, 'Java 1 + Python 1 + Node 1');
  assert.equal(r.failed, 0);
  assert.match(r.cmd, /javac/);
  assert.match(r.cmd, /python3/);
  assert.match(r.cmd, /node --test/);
});

test('工作区里没有可执行产物时，明确说没有（不是假绿）', async () => {
  const root = tmp('empty');
  exec.writeFiles(root, [{ path: 'README.md', content: '# 空' }]);
  const r = await exec.runWorkspaceTests(root);
  assert.equal(r.ok, false);
  assert.equal(r.exit_code, -1);
  assert.match(r.tail, /没有可执行的测试产物/);
});

test('CDS 结构性校验：实体缺 key / 花括号不配对都报出来', () => {
  const root = tmp('cds');
  const good = `namespace order.manage;

entity Orders {
  key ID : UUID;
  amount : Decimal(15, 2);
}

service OrderService {
  entity Orders as projection on order.manage.Orders;
}
`;
  exec.writeFiles(root, [{ path: 'db/schema.cds', content: good }, { path: 'srv/order-service.cds', content: good }]);
  const okc = exec.checkCds(root);
  assert.ok(okc.ok, JSON.stringify(okc.errors));
  assert.equal(okc.files, 2);

  exec.writeFiles(root, [{ path: 'db/bad.cds', content: 'entity Items {\n  name : String;\n}\n' }, { path: 'db/broken.cds', content: 'namespace x\nentity Y {\n  key ID : UUID;\n' }]);
  const badc = exec.checkCds(root);
  assert.equal(badc.ok, false);
  assert.ok(badc.errors.some(e => /没有 key/.test(e.error)), JSON.stringify(badc.errors));
  assert.ok(badc.errors.some(e => /花括号/.test(e.error)), JSON.stringify(badc.errors));
});
