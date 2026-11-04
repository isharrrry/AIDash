/**
 * Runner 的常见 harness 配置模板。
 *
 * 模板只描述“怎么把 runner 的 {task_file} 交给 CLI、结果写回 {result_file}”。
 * 不猜测用户本机的路径或模型：命令名必须在 PATH 中，凭据由各 CLI 自己的配置
 * 或 .env 提供——runner 的子进程环境白名单刻意不放行 *_KEY/_TOKEN。
 *
 * 参数以 argv 数组保存，不经过 shell：Windows 的引号转义是这类集成最常见的
 * 失败点，数组直传能让 `-p "长提示词"` 原样到达 CLI。
 */

export const TASK_PROMPT =
  'Read and execute the task file: {task_file}. When finished, write the result JSON to {result_file} with fields summary, detail_md, result, task_id; task_id must equal the id in the task file.';

const COMMON_NOTES = [
  '命令必须已在 PATH 中可执行；模板不会自动安装任何 CLI。',
  '凭据不要写进配置：优先使用各 CLI 自己的登录态或工作目录下的 .env。',
  '如果本机 CLI 参数有差异，可在“命令与参数”里直接改 argv 数组。',
];

export const HARNESS_TEMPLATES = [
  {
    key: 'claude',
    name: 'Claude Code CLI',
    command: 'claude',
    description: 'Anthropic Claude Code 的非交互 -p 模式，最常用；支持 --resume 续会话。',
    install_hint: 'npm install -g @anthropic-ai/claude-code',
    credential_hint: '先运行 claude 完成登录，或由 CLI 自己的配置提供凭据。',
    argv: [
      'claude',
      '--dangerously-skip-permissions',
      '-p',
      TASK_PROMPT,
    ],
    result_file: '{task_file_dir}/claude-result.json',
    capability: 'claude',
    notes: [
      ...COMMON_NOTES,
      '--dangerously-skip-permissions 允许无人值守执行；仅在可信工作目录使用。',
    ],
  },
  {
    key: 'codex',
    name: 'OpenAI Codex CLI',
    command: 'codex',
    description: 'Codex CLI 的 exec 无头模式；适合已用 OpenAI/兼容端点的环境。',
    install_hint: 'npm install -g @openai/codex',
    credential_hint: '先运行 codex login，或配置 ~/.codex/config.toml 与相应环境变量。',
    argv: [
      'codex',
      'exec',
      '--full-auto',
      '--skip-git-repo-check',
      TASK_PROMPT,
    ],
    result_file: '{task_file_dir}/codex-result.json',
    capability: 'codex',
    notes: [
      ...COMMON_NOTES,
      '--full-auto 等价于无人值守审批；若当前版本不识别，可改为 -a never -s workspace-write。',
      '--skip-git-repo-check 让非 git 目录也能执行任务。',
    ],
  },
  {
    key: 'dsh',
    name: 'DeepSeek dsh（headless）',
    command: 'dsh',
    description: 'DeepSeek Harness 的 headless profile：一次任务、输出最终答案后退出。',
    install_hint: 'npm install -g @deepseek-ai/dsh',
    credential_hint:
      '先在 dsh web 的 Models 页写入 $DSH_HOME/.credentials.yaml，或在 runner 的工作目录放 .env 并写 DEEPSEEK_API_KEY=...；runner 的环境白名单不会传递 *_KEY。',
    argv: [
      'dsh',
      '--profile',
      'headless',
      TASK_PROMPT,
    ],
    result_file: '{task_file_dir}/dsh-result.json',
    capability: 'dsh',
    notes: [
      ...COMMON_NOTES,
      'dsh --profile headless 与简写 dsh headless "<任务>" 等价；headless 的最后一个位置参数就是要执行的任务。',
      '凭据顺序：继承环境 → $DSH_HOME/.credentials.yaml → 项目/用户 .env；runner 子进程拿不到 *_KEY，优先用工作目录 .env 或 credentials 文件。',
      '如需继续同一会话，可加 --session-id <id>；模板默认每次新会话。',
    ],
  },
  {
    key: 'narnat',
    name: 'Narnat CLI（headless -p）',
    command: 'narnat',
    description: 'NarnatAgent 终端智能体的 headless 一次性任务模式。',
    install_hint: '从 https://gitcode.com/xyint/NarnatAgent 下载 Windows 发行包并把 narnat.exe 加入 PATH；Linux 可按其 README 从源码构建',
    credential_hint:
      '首次启动后编辑 narnat 程序目录下 .narnat/config/narnat.json 的“接口密钥”；也可用 NARNAT_HOME 指向 .narnat 所在目录。',
    argv: [
      'narnat',
      '-p',
      TASK_PROMPT,
    ],
    result_file: '{task_file_dir}/narnat-result.json',
    capability: 'narnat',
    notes: [
      ...COMMON_NOTES,
      'Narnat 的 -p/--prompt 是单轮 headless：执行一次后退出，不读 stdin、不保存会话。',
      '需要完成验证与自动续跑时加 -g N（--goal-rounds N，审核模式，N 为续跑预算，0 等同不开启）；不带 -g 时 reason=done 只表示执行结束，不保证任务达成。',
      'headless 末行输出 [NN_DONE] reason=… rounds=… 哨兵；退出码 0=正常收尾（含 round_limit）、1=参数/启动错误、2=任务级失败，runner 仍以结果文件与退出码为准。',
      'Narnat 发行包以 Windows 为主；Linux 可按其 README 从源码构建（glibc ≥ 2.35）。',
    ],
  },
  {
    key: 'custom',
    name: '自定义命令',
    command: '',
    description: '自行填写 argv 数组；适合内部 harness 或脚本。',
    install_hint: '把可执行文件放进 PATH，或填写绝对路径。',
    credential_hint: '由自定义命令自行处理凭据；不要写进配置文件。',
    argv: ['<your-harness>', '--task', '{task_file}', '--result', '{result_file}'],
    result_file: '{task_file_dir}/result.json',
    capability: 'custom',
    notes: [
      'argv 中可使用 {task_file}、{task_file_dir}、{result_file} 占位符。',
      '命令必须自己读取任务并写出 result_file；runner 不会替它生成结果。',
    ],
  },
];

export function getTemplate(key) {
  return HARNESS_TEMPLATES.find((item) => item.key === key) ?? null;
}

export function templateSummaries() {
  return HARNESS_TEMPLATES.map((item) => ({
    key: item.key,
    name: item.name,
    command: item.command,
    description: item.description,
    install_hint: item.install_hint,
    credential_hint: item.credential_hint,
    argv: item.argv,
    result_file: item.result_file,
    capability: item.capability,
    notes: item.notes,
  }));
}
