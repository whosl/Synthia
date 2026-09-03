import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface Gjb9764Issue {
  readonly file: string;
  readonly message: string;
}

export interface DocumentContract {
  readonly file: string;
  readonly documentId: string;
  readonly titleMarker: string;
  readonly sections: readonly string[];
  readonly extraMarkers?: readonly string[];
}

const contracts: readonly DocumentContract[] = [
  {
    file: "00-项目保证与裁剪说明.md",
    documentId: "UART-DOC-000",
    titleMarker: "项目保证与裁剪说明",
    sections: ["1 目的", "2 规范来源与适用边界", "3 项目概况", "4 文档集与裁剪候选", "5 权限、配置和证据规则", "6 当前阶段判定"],
    extraMarkers: ["PLDSVTP/PLDSVTD/PLDSVTR", "阻塞"],
  },
  {
    file: "01-可编程逻辑器件软件研制任务书.md",
    documentId: "UART-DOC-001",
    titleMarker: "（PLDSDTD）",
    sections: ["1 范围", "2 引用文档", "3 运行环境要求", "4 任务要求", "5 接口关系", "6 关键性要求", "7 设计约束", "8 管理要求", "9 质量保证", "10 验收与交付", "11 维护"],
    extraMarkers: ["6.1 可靠性", "6.2 安全性", "6.3 软件可编程要求", "6.4 保密性", "6.5 其他要求"],
  },
  {
    file: "02-可编程逻辑器件软件需求规格说明.md",
    documentId: "UART-DOC-002",
    titleMarker: "（PLDSRS）",
    sections: ["1 范围", "2 引用文档", "3 工程需求", "4 交付准备"],
    extraMarkers: Array.from({ length: 15 }, (_, index) => `3.${index + 1} `),
  },
  {
    file: "03-可编程逻辑器件软件设计说明.md",
    documentId: "UART-DOC-003",
    titleMarker: "（PLDSDD）",
    sections: ["1 范围", "2 引用文档", "3 概要设计", "4 详细设计", "5 验证设计", "6 可追踪性"],
    extraMarkers: ["3.1 总体结构原理", "3.2 功能模块设计", "合并"],
  },
  {
    file: "04-可编程逻辑器件软件仿真测试计划.md",
    documentId: "UART-DOC-004",
    titleMarker: "（PLDSSTP）",
    sections: ["1 范围", "2 引用文档", "3 测试要求与测试策略", "4 仿真测试环境", "5 测试内容", "6 测试进度", "7 可追踪性"],
    extraMarkers: ["3.1 测试总体要求", "3.2 测试策略和方法", "5.1 接口测试需求", "5.2 功能测试需求"],
  },
  {
    file: "05-可编程逻辑器件软件仿真测试说明.md",
    documentId: "UART-DOC-005",
    titleMarker: "（PLDSSTD）",
    sections: ["1 范围", "2 引用文档", "3 仿真测试环境", "4 测试说明", "5 可追踪性"],
    extraMarkers: ["涉及需求", "先决条件", "测试输入", "预期的测试结果", "评价结果的准则", "终止条件", "测试过程", "假设和约束"],
  },
  {
    file: "06-可编程逻辑器件软件仿真测试报告.md",
    documentId: "UART-DOC-006",
    titleMarker: "（PLDSSTR）",
    sections: ["1 范围", "2 引用文档", "3 测试概述", "4 详细测试结果", "5 评估和建议"],
    extraMarkers: ["4.1.1 功能仿真测试结果总结", "4.1.2 门级仿真测试结果总结", "4.1.3 时序仿真测试结果总结", "4.1.4 静态时序分析结果总结", "4.2 测试充分性分析", "附录 A 测试执行结果记录", "附录 B 问题报告单"],
  },
  {
    file: "07-可追踪性矩阵.md",
    documentId: "UART-DOC-007",
    titleMarker: "可追踪性矩阵",
    sections: ["1 状态语义", "2 任务到需求", "3 需求到设计、实现和验证", "4 设计到文件", "5 覆盖指标", "6 变更影响"],
  },
  {
    file: "08-设计评审记录.md",
    documentId: "UART-DOC-008",
    titleMarker: "设计评审记录",
    sections: ["1 记录边界", "2 关键发现及整改", "3 候选检查单", "4 当前阻断项", "5 候选结论", "6 人工评审记录占位"],
  },
  {
    file: "09-UART 板级与逻辑接口需求规格说明.md",
    documentId: "UART-DOC-009",
    titleMarker: "（IRS）",
    sections: ["1 范围", "2 引用文档", "3 接口需求", "4 质量与合格性", "5 需求可追踪性", "6 注释"],
    extraMarkers: ["UART-IRS-005", "阻塞", "XC7VX690T"],
  },
  {
    file: "10-UART 板级与逻辑接口设计说明.md",
    documentId: "UART-DOC-010",
    titleMarker: "（IDD）",
    sections: ["1 范围", "2 引用文档", "3 接口设计决策", "4 接口详细设计", "5 需求可追踪性", "6 注释"],
    extraMarkers: ["uart_board_top", "blocked", "UART-IDD-004"],
  },
  {
    file: "11-UART 收发器可编程逻辑器件软件可行性和风险分析报告.md",
    documentId: "UART-DOC-011",
    titleMarker: "（PLDSFARAR）",
    sections: ["1 范围", "2 引用文档", "3 需求分析", "4 可行性分析", "5 必要性分析", "6 继承性分析", "7 风险分析"],
    extraMarkers: ["精确 part", "历史 K70T", "Agent 冒充批准"],
  },
  {
    file: "12-UART 收发器软件开发计划.md",
    documentId: "UART-DOC-012",
    titleMarker: "（SDP）",
    sections: ["1 范围", "2 引用文档", "3 软件开发概述", "4 组织和责职", "5 软件开发活动", "6 进度和控制节点", "7 资源、风险和测量", "8 配置、质量、保密和分承制方", "9 注释"],
    extraMarkers: ["全角色模型", "G4", "blocked by coverage/independent review/board/approval"],
  },
  {
    file: "13-UART 收发器软件配置管理计划.md",
    documentId: "UART-DOC-013",
    titleMarker: "（SCMP）",
    sections: ["1 范围", "2 引用文档", "3 组织和职责", "4 软件配置管理活动", "5 工具、技术和方法", "6 对供货单位的控制", "7 进度表", "8 注释"],
    extraMarkers: ["配置标识", "状态记实", "发行/交付"],
  },
  {
    file: "14-UART 收发器软件质量保证计划.md",
    documentId: "UART-DOC-014",
    titleMarker: "（SQAP）",
    sections: ["1 范围", "2 引用文档", "3 组织和职责", "4 标准、条例和约定", "5 活动审核", "6 工作产品审核", "7 不符合问题解决", "8 工具、技术和方法", "9 对供货单位的控制", "10 记录的收集、维护和保存", "11 注释"],
    extraMarkers: ["独立 V&V", "覆盖模型和分母审定", "精确 part/profile"],
  },
  {
    file: "15-UART 收发器软件移交计划.md",
    documentId: "UART-DOC-015",
    titleMarker: "（STrP）",
    sections: ["1 范围", "2 引用文档", "3 软件保障资源", "4 推荐规程", "5 培训", "6 预期更改区域", "7 移交计划", "8 注释"],
    extraMarkers: ["精确 690T profile", "blocked by schematic archive/physical board/approval", "不得宣称已移交"],
  },
  {
    file: "16-UART 收发器可编程逻辑器件软件确认测试计划.md",
    documentId: "UART-DOC-016",
    titleMarker: "（PLDSVTP）",
    sections: ["1 范围", "2 引用文档", "3 测试要求与测试策略", "4 确认测试环境", "5 测试内容", "6 测试进度", "7 可追踪性"],
    extraMarkers: ["blocked candidate", "VTI-005", "115200"],
  },
  {
    file: "17-UART 收发器可编程逻辑器件软件确认测试说明.md",
    documentId: "UART-DOC-017",
    titleMarker: "（PLDSVTD）",
    sections: ["1 范围", "2 引用文档", "3 确认测试环境", "4 测试说明", "5 可追踪性"],
    extraMarkers: ["VTC-004", "blocked", "执行覆盖为 0"],
  },
  {
    file: "18-UART 收发器可编程逻辑器件软件确认测试报告.md",
    documentId: "UART-DOC-018",
    titleMarker: "（PLDSVTR）",
    sections: ["1 范围", "2 引用文档", "3 测试概述", "4 详细测试结果", "5 评估和建议", "附录 A 测试执行结果记录表", "附录 B 问题报告单"],
    extraMarkers: ["未执行", "已执行", "不宣称任何确认测试通过"],
  },
  {
    file: "19-UART 收发器软件产品规格说明.md",
    documentId: "UART-DOC-019",
    titleMarker: "（SPS）",
    sections: ["1 范围", "2 引用文档", "3 需求", "4 合格性规定", "5 软件支持信息", "6 需求可追踪性", "7 注释"],
    extraMarkers: ["无获批产品基线", "bitstream", "blocked"],
  },
  {
    file: "20-UART 收发器软件版本说明.md",
    documentId: "UART-DOC-020",
    titleMarker: "（SVD）",
    sections: ["1 范围", "2 引用文档", "3 版本说明", "4 注释"],
    extraMarkers: ["不是已发布 SVD", "不可安装/固化", "没有伪造发布号"],
  },
  {
    file: "21-UART 收发器可编程逻辑器件软件使用说明.md",
    documentId: "UART-DOC-021",
    titleMarker: "（PLDSUD）",
    sections: ["1 范围", "2 引用文档", "3 功能概述", "4 主要技术指标", "5 物理特性", "6 使用说明", "7 固化"],
    extraMarkers: ["不支持板级固化", "本章无可执行固化步骤", "XC7VX690T"],
  },
  {
    file: "22-UART 收发器可编程逻辑器件软件研制总结报告.md",
    documentId: "UART-DOC-022",
    titleMarker: "（PLDSDSR）",
    sections: ["1 范围", "2 任务来源与可编程逻辑器件软件研制依据", "3 可编程逻辑器件软件概述", "4 可编程逻辑器件软件研制过程", "5 满足任务指标情况", "6 可编程逻辑器件软件测试", "7 质量保证情况", "8 配置管理情况", "9 可靠性、安全性分析", "10 测量与分析", "11 结论"],
    extraMarkers: ["项目未收尾", "VC709/690T exploratory", "不能结论"],
  },
  {
    file: "23-UART 收发器软件配置管理报告.md",
    documentId: "UART-DOC-023",
    titleMarker: "（SCMR）",
    sections: ["1 范围", "2 引用文档", "3 配置管理情况综述", "4 基本信息", "5 专业组和权限", "6 配置项记录", "7 变更记录", "8 基线记录", "9 入库记录", "10 出库记录", "11 审核记录", "12 备份记录", "13 测量", "14 注释"],
    extraMarkers: ["没有获授权人类批准", "本章无内容", "manifest.sha256"],
  },
  {
    file: "24-UART 收发器软件质量保证报告.md",
    documentId: "UART-DOC-024",
    titleMarker: "（SQAR）",
    sections: ["1 范围", "2 引用文档", "3 软件研制概述", "4 软件质量保证情况", "5 软件配置管理情况", "6 第三方评测情况", "7 注释"],
    extraMarkers: ["本章无内容", "第三方评测", "review_required"],
  },
];

const commonMarkers = [
  "## 封面",
  "文档标识及版本",
  "数据分类",
  "编制单位",
  "编写",
  "审核",
  "批准",
  "## 修改页",
  "修改内容",
  "修改人",
  "## 目录",
];

const standardContracts = [
  {
    baseName: "GBT11457-2006",
    sha256: "7d7af3dfb969bb7639c213396d9338f50fd425b028d26874240f43f094b83f91",
    pageCount: 263,
    sourceKind: "official-full-text",
    directlyReferences: [],
    markers: ["信息技术 软件工程术语", "## 2 术语定义及缩略语", "2.1859", "### PDF 第 263 页"],
  },
  {
    baseName: "GJB2786A-2009",
    sha256: "05e05d4a325292cac939aaf34065db13c79d74d99db1028b811af554e80bc18c",
    pageCount: 42,
    sourceKind: "public-preview-reconstruction",
    directlyReferences: ["GBT11457-2006", "GJB438B-2009"],
    markers: ["军用软件开发通用要求", "## 4 一般要求", "## 5 详细要求", "### PDF 第 42 页"],
  },
  {
    baseName: "GJB9764-2020",
    sha256: "b37a6b48c8e07ff3f1fc0a8ff65208c44117f79b6a876760720a53531b07411b",
    pageCount: 46,
    sourceKind: "user-supplied-scan",
    directlyReferences: ["GBT11457-2006", "GJB438B-2009", "GJB9432-2018"],
    markers: ["军用可编程逻辑器件软件文档编制规范", "GJB 438B-2009", "## 4 一般要求", "## 5 详细要求"],
  },
  {
    baseName: "GJB438B-2009",
    sha256: "564413d0dc71b02824942fea469f483bb558539166b5bc35d6429cad1019e010",
    pageCount: 98,
    sourceKind: "user-supplied-scan",
    directlyReferences: ["GBT11457-2006", "GJB2786A-2009"],
    markers: ["军用软件开发文档通用要求", "## 4 一般要求", "## 附录 G（规范性）", "## 附录 BB（资料性）"],
  },
  {
    baseName: "GJB5235-2004",
    sha256: "7f2f6429643bcae81bc7d669d77a21307f5cb4238576af724e0116abe5392fa5",
    pageCount: 14,
    sourceKind: "public-preview-reconstruction",
    directlyReferences: ["GBT8566-2022", "GBT11457-2006"],
    markers: ["军用软件配置管理", "## 6 软件配置标识", "## 10 软件的发行管理和交付", "### PDF 第 14 页"],
  },
  {
    baseName: "GJB9433-2018",
    sha256: "d397cf357d394ed0341758a986f11b34afab1e245070cd62a674f7e918e7937b",
    pageCount: 14,
    sourceKind: "public-preview-reconstruction",
    directlyReferences: ["GBT11457-2006", "GJB9432-2018"],
    markers: ["军用可编程逻辑器件软件测试要求", "## 5 详细要求", "## 附录 A～C", "### PDF 第 14 页"],
  },
  {
    baseName: "GJB9432-2018",
    sha256: "1a6a8c4781c39951304a5e9f6611c39cbc4f8bb879dd0e89ab9beb5b632a84c8",
    pageCount: 11,
    sourceKind: "user-supplied-complete-copy",
    directlyReferences: ["GBT11457-2006", "GJB5235-2004", "GJB9433-2018"],
    markers: ["军用可编程逻辑器件软件开发通用要求", "## PDF 第 03 页", "5.1 系统需求分析", "## PDF 第 11 页"],
  },
] as const;

interface StandardManifestEntry {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly pageCount?: unknown;
  readonly expectedPageCount?: unknown;
  readonly sha256?: unknown;
  readonly pdfFile?: unknown;
  readonly markdownFile?: unknown;
  readonly source?: { readonly kind?: unknown; readonly fragmentPageCount?: unknown; readonly fragmentSha256?: unknown };
  readonly corroboration?: {
    readonly kind?: unknown;
    readonly pageCount?: unknown;
    readonly sha256?: unknown;
    readonly result?: unknown;
  };
  readonly directlyReferences?: unknown;
}

const corroborationContracts = new Map([
  ["GJB2786A-2009", { pageCount: 42, sha256: "c43dfa87ff36b96d105cd263518d216ae99969f5f372fb1aa10f9c58e0b7c86f" }],
  ["GJB5235-2004", { pageCount: 14, sha256: "7ee5d13d5dea89e603efa3c349178cc9961c6e3939cd5efc0070ca79ad61a273" }],
  ["GJB9433-2018", { pageCount: 14, sha256: "60dd9265b95adda950cd8d6160aa837284fcbebe53f55e3a8bd156cbca79996f" }],
] as const);

function sameStringArray(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

async function checkStandardsManifest(standardsDir: string): Promise<Gjb9764Issue[]> {
  const issues: Gjb9764Issue[] = [];
  const manifestPath = resolve(standardsDir, "standards.json");
  let parsed: { readonly schemaVersion?: unknown; readonly standards?: unknown };
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8")) as typeof parsed;
  } catch (error) {
    return [{ file: "standards.json", message: `无法读取或解析机器清单：${error instanceof Error ? error.message : String(error)}` }];
  }
  if (parsed.schemaVersion !== 1) {
    issues.push({ file: "standards.json", message: "schemaVersion 必须为 1" });
  }
  if (!Array.isArray(parsed.standards)) {
    return [...issues, { file: "standards.json", message: "standards 必须为数组" }];
  }

  const entries = parsed.standards as StandardManifestEntry[];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (byId.size !== entries.length) {
    issues.push({ file: "standards.json", message: "标准 id 缺失或重复" });
  }
  for (const contract of standardContracts) {
    const entry = byId.get(contract.baseName);
    if (!entry) {
      issues.push({ file: "standards.json", message: `缺少标准条目：${contract.baseName}` });
      continue;
    }
    if (entry.status !== "available") issues.push({ file: "standards.json", message: `${contract.baseName} 状态必须为 available` });
    if (entry.pageCount !== contract.pageCount) issues.push({ file: "standards.json", message: `${contract.baseName} 页数不匹配` });
    if (entry.sha256 !== contract.sha256) issues.push({ file: "standards.json", message: `${contract.baseName} SHA-256 不匹配` });
    if (entry.pdfFile !== `${contract.baseName}.pdf`) issues.push({ file: "standards.json", message: `${contract.baseName} PDF 文件名不匹配` });
    if (entry.markdownFile !== `${contract.baseName}.md`) issues.push({ file: "standards.json", message: `${contract.baseName} Markdown 文件名不匹配` });
    if (entry.source?.kind !== contract.sourceKind) issues.push({ file: "standards.json", message: `${contract.baseName} 来源类型不匹配` });
    if (!sameStringArray(entry.directlyReferences, contract.directlyReferences)) {
      issues.push({ file: "standards.json", message: `${contract.baseName} 直接引用关系不匹配` });
    }
    const corroboration = corroborationContracts.get(contract.baseName);
    if (corroboration && (
      entry.corroboration?.kind !== "user-supplied-complete-copy"
      || entry.corroboration.pageCount !== corroboration.pageCount
      || entry.corroboration.sha256 !== corroboration.sha256
      || typeof entry.corroboration.result !== "string"
      || !entry.corroboration.result.includes("match")
    )) {
      issues.push({ file: "standards.json", message: `${contract.baseName} 用户完整副本交叉核对证据不匹配` });
    }
  }

  const gbt8566 = byId.get("GBT8566-2022");
  if (!gbt8566 || gbt8566.status !== "available" || gbt8566.source !== "scribd_screenshot_reconstruction") {
    issues.push({ file: "standards.json", message: "GB/T 8566 必须登记为 Scribd 截图重建（available + scribd_screenshot_reconstruction），且注明非官方版本" });
  }
  if (byId.size !== standardContracts.length + 1) {
    issues.push({ file: "standards.json", message: "机器清单存在未纳入校验契约的标准条目" });
  }

  // GB/T 8566 files are now permitted (Scribd reconstruction); verify both exist.
  const directoryEntries = await readdir(resolve(standardsDir));
  for (const required of ["GBT8566-2022.pdf", "GBT8566-2022.md"]) {
    if (!directoryEntries.includes(required)) {
      issues.push({ file: required, message: "Scribd 重建的 GB/T 8566 PDF 与转写稿必须同时入库" });
    }
  }
  return issues;
}

export async function checkGjbStandardReferences(
  standardsDir = "skills/fpga/references/standards",
): Promise<Gjb9764Issue[]> {
  const issues: Gjb9764Issue[] = [];
  for (const contract of standardContracts) {
    const pdfPath = resolve(standardsDir, `${contract.baseName}.pdf`);
    const markdownPath = resolve(standardsDir, `${contract.baseName}.md`);
    let pdf: Buffer;
    let markdown: string;
    try {
      [pdf, markdown] = await Promise.all([readFile(pdfPath), readFile(markdownPath, "utf8")]);
    } catch (error) {
      issues.push({
        file: contract.baseName,
        message: `无法读取标准 PDF 或检索转写：${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const actualHash = createHash("sha256").update(pdf).digest("hex");
    if (actualHash !== contract.sha256) {
      issues.push({ file: `${contract.baseName}.pdf`, message: `SHA-256 不匹配：${actualHash}` });
    }
    for (const marker of contract.markers) {
      if (!markdown.includes(marker)) {
        issues.push({ file: `${contract.baseName}.md`, message: `转写缺少必需标记：${marker}` });
      }
    }
  }
  const catalogPath = resolve(standardsDir, "document-catalog.md");
  try {
    const catalog = await readFile(catalogPath, "utf8");
    const requiredCatalogMarkers = [
      "GJB 9764-2020 文档矩阵",
      "Word 候选/模板覆盖为 22/22",
      "PLDSFARAR",
      "PLDSDTD",
      "PLDSVTP",
      "PLDSVTD",
      "PLDSVTR",
      "PLDSDSR",
      "SCMR",
      "SQAR",
      "按需系统级文档",
    ];
    for (const marker of requiredCatalogMarkers) {
      if (!catalog.includes(marker)) {
        issues.push({ file: "document-catalog.md", message: `文档目录缺少必需标记：${marker}` });
      }
    }
  } catch (error) {
    issues.push({
      file: "document-catalog.md",
      message: `无法读取文档目录：${error instanceof Error ? error.message : String(error)}`,
    });
  }
  issues.push(...await checkStandardsManifest(standardsDir));
  return issues;
}

export function checkGjb9764DocumentText(contract: DocumentContract, text: string): Gjb9764Issue[] {
  const issues: Gjb9764Issue[] = [];
  const required = [...commonMarkers, contract.documentId, contract.titleMarker, ...contract.sections, ...(contract.extraMarkers ?? [])];

  for (const marker of required) {
    if (!text.includes(marker)) {
      issues.push({ file: contract.file, message: `缺少必需标记：${marker}` });
    }
  }

  let cursor = -1;
  for (const section of contract.sections) {
    const next = text.indexOf(`## ${section}`);
    if (next === -1) continue;
    if (next <= cursor) {
      issues.push({ file: contract.file, message: `正文章条顺序错误：${section}` });
    }
    cursor = next;
  }

  if (!text.includes("candidate") && !text.includes("未批准")) {
    issues.push({ file: contract.file, message: "未标明候选或未批准状态" });
  }
  if (/批准\s*\|\s*(已批准|通过)/.test(text)) {
    issues.push({ file: contract.file, message: "出现无证据的已批准/通过封面状态" });
  }

  for (const match of text.matchAll(/本(?:章|节)无内容/g)) {
    const context = text.slice(match.index, match.index + 180);
    if (!/(理由|未提供|缺少|当前无|尚无|阻塞|待)/.test(context)) {
      issues.push({ file: contract.file, message: "裁剪章条未在邻近文本中说明理由或状态" });
    }
  }

  return issues;
}

export async function checkGjb9764Docs(docsDir = "golden/uart/docs"): Promise<Gjb9764Issue[]> {
  const resolvedDir = resolve(docsDir);
  const issues: Gjb9764Issue[] = [];
  let entries: string[];
  try {
    entries = (await readdir(resolvedDir)).filter((entry) => entry.endsWith(".md")).sort();
  } catch (error) {
    return [{ file: docsDir, message: `无法读取文档目录：${error instanceof Error ? error.message : String(error)}` }];
  }

  const expected = contracts.map((contract) => contract.file).sort();
  for (const missing of expected.filter((file) => !entries.includes(file))) {
    issues.push({ file: missing, message: "缺少 GJB 9764 文档集文件" });
  }
  for (const unexpected of entries.filter((file) => !expected.includes(file))) {
    issues.push({ file: unexpected, message: "文档集存在未登记的 Markdown 文件" });
  }

  for (const contract of contracts) {
    if (!entries.includes(contract.file)) continue;
    const text = await readFile(resolve(resolvedDir, contract.file), "utf8");
    issues.push(...checkGjb9764DocumentText(contract, text));
  }

  const wordDir = resolve(resolvedDir, "word");
  let wordEntries: string[] = [];
  try {
    wordEntries = (await readdir(wordDir)).filter((entry) => entry.endsWith(".docx")).sort();
  } catch (error) {
    issues.push({ file: "word", message: `无法读取 Word 文档目录：${error instanceof Error ? error.message : String(error)}` });
  }
  const expectedWord = contracts.map((contract) => contract.file.replace(/\.md$/, ".docx")).sort();
  for (const missing of expectedWord.filter((file) => !wordEntries.includes(file))) {
    issues.push({ file: `word/${missing}`, message: "缺少对应 Word 文档" });
  }
  for (const unexpected of wordEntries.filter((file) => !expectedWord.includes(file))) {
    issues.push({ file: `word/${unexpected}`, message: "Word 文档目录存在未登记文件" });
  }
  for (const file of expectedWord.filter((entry) => wordEntries.includes(entry))) {
    const content = await readFile(resolve(wordDir, file));
    if (content.length < 10_000 || content[0] !== 0x50 || content[1] !== 0x4b) {
      issues.push({ file: `word/${file}`, message: "文件不是有效的非空 DOCX/ZIP 候选" });
    }
  }

  const profileFile = contracts[0].file;
  if (entries.includes(profileFile)) {
    const profile = await readFile(resolve(resolvedDir, profileFile), "utf8");
    for (const marker of ["PLDSVTP/PLDSVTD/PLDSVTR", "阻塞", "不是“不适用”"]) {
      if (!profile.includes(marker)) issues.push({ file: profileFile, message: `确认测试缺口说明缺少：${marker}` });
    }
  }

  issues.push(...await checkGjbStandardReferences());
  return issues;
}

if (import.meta.main) {
  const docsDir = process.argv[2] ?? "golden/uart/docs";
  const issues = await checkGjb9764Docs(docsDir);
  if (issues.length > 0) {
    for (const issue of issues) console.error(`${issue.file}: ${issue.message}`);
    process.exitCode = 1;
  } else {
    console.log(`GJB 9764 documentation check passed: ${contracts.length} files`);
  }
}
