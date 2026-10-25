# AIDash 孪生工程（drawcode）

> 这是 `20-spec` / `30-design` 设计基线的**孪生概要**：一套能编译、能出图、能校验同步的
> C# 声明层。它不是可运行的 AIDash —— AIDash 本体是 TypeScript/Node，这里只建模三件事：
> 模块之间怎么交联、数据在模块间怎么流动、哪些结构要持久化。

用户原话：「我没找到AIDash仓的设计的孪生Drawcode工程在哪，是否做好了同步演进，补齐并检查」

## 之前为什么找不到

仓里此前**没有任何** drawcode 孪生工程：全仓 `grep drawcode / draw.io / 孪生 / twin` 无结果，
也没有 `.drawio` 文件。设计基线只有文档与 `30-design/model/model.json` 的计数，
没有任何「模块交联」的可视化产物。

## 现在有什么

```
80-derived/drawcode/
├── AidashTwin.csproj          # 目标是能 dotnet build（验证声明层语法）
├── DrawcodeAttributes.cs      # 从 drawcode 模板复制的特性定义，不要手改
├── src/                       # 11 个模块（MOD-001~011），信号声明 + 函数体读写
│   ├── Types.cs               # 领域类型名替身（空类，只借类型名让图上标签可读）
│   └── Mod001Entry.cs … Mod011ExternalSystem.cs
├── stores/                    # 18 张表（TBL-001~018），[Drawcode(Store = true)]
│   └── Store*.cs              # 由 generate-stores.mjs 从 05-数据库设计说明.md 生成
├── out/
│   ├── aidash.drawio          # 模块交联图（可拖进 draw.io 编辑）
│   └── aidash.svg             # 同坐标的预览图，不用装 draw.io 也能看
├── generate-stores.mjs        # DDL → stores/*.cs
└── checks/同步检查.mjs         # 孪生 vs 设计基线的一致性断言
```

当前规模：**11 个模块 / 27 个信号 / 36 个函数 / 87 条边（跨模块 38 条）/ 18 张表 203 列**。

## 三条命令

```bash
# 1. 表结构：设计文档改了 DDL 之后重新生成
node 80-derived/drawcode/generate-stores.mjs

# 2. 出图：改了 src/ 里的信号或函数之后重新生成
#    DRAWCODE_TS 指向 drawcode 仓的 CLI（不在本仓，因为它是独立开源项目）
DRAWCODE_TS=/path/to/drawcode/typescript/bin/drawcode.ts
node "$DRAWCODE_TS" build 80-derived/drawcode/src/*.cs \
    --root 80-derived/drawcode/src --merge \
    --out 80-derived/drawcode/out/aidash.drawio \
    --svg 80-derived/drawcode/out/aidash.svg

# 3. 校验：这一步回答「孪生是否还等于设计」
DRAWCODE_TS="$DRAWCODE_TS" node 80-derived/drawcode/checks/同步检查.mjs
```

`同步检查.mjs` 不设 `DRAWCODE_TS` 也能跑：它会跳过「产物是否由当前源码重新生成」这一条，
并在输出里**明确写出跳过了什么**，不会静默当作通过。

## 同步检查查什么

| 断言 | 抓的是什么漂移 |
| :--- | :--- |
| 模块覆盖 | 设计有 11 个模块，孪生漏建了某个（图上直接没有这个节点） |
| 表覆盖 | 设计有 18 张表，`stores/` 里少一张 |
| 设计依赖有对应边 | 概要设计写了「MOD-003 依赖 MOD-002/007」，图上两者之间却没有任何数据流 |
| 无孤岛 | 某个模块有节点但一条跨模块边都没有 —— 等于没建模交联 |
| 产物一致性 | `src/` 改了但 `out/aidash.drawio` 没重新生成 |

**这些断言失败即退出码 1**，可以直接挂到 CI。故意不做「警告但通过」：图的过期是静默的，
一旦允许它通过，孪生就会慢慢变成一张没人信的历史截图。

## 设计改了该改哪里

| 设计变化 | 孪生要动的地方 |
| :--- | :--- |
| 改表结构（增删列、改类型） | 什么都不用手改 —— 重跑 `generate-stores.mjs` |
| 新增/删除模块 | `src/` 下加/删一个 `ModXXX*.cs`，类上标 `[Drawcode(Root = "MOD-xxx ...")]` |
| 模块新增一条跨模块数据流 | 在**产生方**声明信号（`Direction.In`），在**消费方**函数体里读它 |
| 模块间依赖关系变化 | 同上；检查脚本会按 `概要设计.md` 的第 4 列重新比对 |
| 只是画法/布局调整 | 在 draw.io 里拖动后 `sync` 回源码，或直接改 `--layout-from` |

**不要手改 `out/`**：它是派生的。手改会在下一次 `build` 时被覆盖，而且同步检查会报不一致。

## 建模口径（改之前先看）

- **信号只在产生方声明一次**。drawcode 按信号名全局映射（`signalsByName`），
  同名声明后写的会覆盖先写的，边会指向错误的文件。消费方只在函数体里读。
- **边只来自函数体的读写语句**。注释不产生任何边；改注释不会移动任何线。
  这是 drawcode 的核心主张 —— 图跟着代码走，不跟着文档走。
- **`Direction` 是「相对本模块」**：`In` = 本模块产生，`Out` = 本模块消费。
  全线只有两处 `Out`：MOD-006 的 OKF 文档（外部只读目录）、MOD-011 的外部系统（范围外）（已移出本仓）。
- **不要用 `record`**：drawcode 的 C# 解析器会整段跳过 record 声明，用它会让类型在模型里消失。
- **函数名全局唯一**：drawcode 的 `rawFuncs` 是 `Map<name, ...>`，同名函数后者覆盖前者。

## 已知取舍

1. **它是概要，不是全量**。36 个函数对应的是「每个模块 2~5 条主干动作」，
   不是 `40-build` 里的每一个 handler。要逐函数对齐实现，应该用 `drawcode inspect` 读编译产物，
   而不是把声明层写成第二份实现。
2. **MOD-011 是一个孤立节点**。它已移出本仓，保留它只为画出边界（`External = true` 虚线）。
   检查脚本对它有豁免，其余模块没有。
3. **`stores/` 的字段名保持 snake_case**，与 DDL 逐字对应。转成 PascalCase 更「C#」，
   但会让「哪一列对应哪个字段」需要二次翻译，反而妨碍对照。
4. **`event` 这类 C# 关键字列要写成 `@event`**。生成器已处理；`@` 前缀会让 drawcode 的
   字段正则认不出这一列，但它本来就不是信号，只影响 ER 视图的这一格。
