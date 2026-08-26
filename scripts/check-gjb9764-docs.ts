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
    baseName: "GJB9764-2020",
    sha256: "b37a6b48c8e07ff3f1fc0a8ff65208c44117f79b6a876760720a53531b07411b",
    markers: ["军用可编程逻辑器件软件文档编制规范", "GJB 438B-2009", "## 4 一般要求", "## 5 详细要求"],
  },
  {
    baseName: "GJB438B-2009",
    sha256: "564413d0dc71b02824942fea469f483bb558539166b5bc35d6429cad1019e010",
    markers: ["军用软件开发文档通用要求", "## 4 一般要求", "## 附录 G（规范性）", "## 附录 BB（资料性）"],
  },
] as const;

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
        message: `无法读取权威扫描件或检索转写：${error instanceof Error ? error.message : String(error)}`,
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
