#!/usr/bin/env python3
"""Build the 22 GJB 9764 document candidates plus 3 support DOCX files.

The Markdown files remain the reviewable source.  Missing document types are
materialized as honest candidate templates: known facts are filled, unavailable
hardware/approval/results are explicitly blocked, and no human signature or
baseline decision is synthesized.
"""

from __future__ import annotations

import re
from pathlib import Path
from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Inches, Pt, RGBColor


ROOT = Path(__file__).resolve().parents[1]
DOCS_DIR = ROOT / "golden" / "uart" / "docs"
WORD_DIR = DOCS_DIR / "word"
VERSION = "v2.5 candidate"
DATE = "2026-08-28"

COMMON_REFS = """| 文档标识 | 标题 | 状态 |
|---|---|---|
| GB/T 11457-2006 | 软件工程术语 | 国家标准全文公开系统原始 PDF；受控性待审核 |
| GJB 2786A-2009 | 军用软件开发通用要求 | 仓库完整重建件及用户副本交叉核对；受控性待审核 |
| GJB 5235-2004 | 军用软件配置管理 | 仓库完整重建件及用户副本交叉核对；受控性待审核 |
| GJB 9432-2018 | 军用可编程逻辑器件软件开发通用要求 | 用户提供的 11 页完整副本；受控性待审核 |
| GJB 9433-2018 | 军用可编程逻辑器件软件测试要求 | 仓库参考副本；受控性待审核 |
| GJB 9764-2020 | 军用可编程逻辑器件软件文档编制规范 | 仓库完整扫描与校读转写 |
| GJB 438B-2009 | 军用软件开发文档通用要求 | 仓库完整扫描与校读转写 |
| GB/T 8566-2022 | 系统与软件工程 软件生存周期过程 | 用户已定位原文；仓库尚未同步、哈希和版本复核 |
| UART-DOC-000 | 项目保证与裁剪说明 | v2.5 candidate |"""

PROJECT_FACTS = (
    "本文档适用于 GOLDEN-UART 候选项目。目标平台已固定为 AMD/Xilinx VC709 Rev 1.0 候选板、"
    "`xc7vx690tffg1761-2`、`uart_top` 通用核 + `uart_board_top` 板级包装、200 MHz 差分板钟经 MMCM"
    "生成 100 MHz 核时钟，以及板载 CP2103 USB-UART。真实 Connector/Vivado 2021.1 已返回精确 part，"
    "9600 与 115200 两组 XSim、综合和停在码流前的实现均已通过 Mac→66 直连形成"
    "修订后 `DIFF_SSTL15` exploratory/candidate 证据。"
)

BLOCKED_HW = (
    "AMD UG887 v1.6 与已入库的 Xilinx XTP213 Rev 1.0 原理图/官方 Master XDC 已交叉确认 "
    "VC709、XC7VX690T-2FFG1761C、200 MHz SYSCLK、CP2103 UART、CPU_RESET、管脚和 I/O 标准候选事实。"
    "本轮未生成 bitstream，也没有实物板卡修订确认、仪器或批准的"
    "确认规程，因此板测、批准、发布和交付仍为阻塞。"
)

ASSURANCE = (
    "项目暂定义为非安全关键/低关键性，但采用中等保证严谨度。必须执行 RX 两级同步与 CDC 评审、"
    "双向追踪、覆盖模型和分母审定、独立验证、已确认目标 part 上的综合/实现/DRC/STA，"
    "以及硬件事实完整后的板级回归。该定义待系统/安全角色依危害分析复核。"
)

ROLES = (
    "采用全角色模型：项目负责人、系统/安全、需求、PLDS 设计、验证、独立 V&V、质量保证、"
    "配置管理、标准/文档控制、硬件/板卡责任人和发布/G4 批准人。人选、独立性、权限和签署待项目负责人审定；"
    "Synthia 只能拟制候选和整理证据，不能充当受权人类批准人。"
)


def table(headers: list[str], rows: list[list[str]]) -> str:
    return "\n".join([
        "| " + " | ".join(headers) + " |",
        "|" + "|".join("---" for _ in headers) + "|",
        *("| " + " | ".join(row) + " |" for row in rows),
    ])


def sec(title: str, *blocks: str) -> tuple[str, list[str]]:
    return title, [block for block in blocks if block]


DOCS: list[dict[str, object]] = [
    {
        "number": 9, "id": "UART-DOC-009", "acronym": "IRS", "name": "UART 板级与逻辑接口需求规格说明",
        "sections": [
            sec("1 范围", PROJECT_FACTS, "本文档单独控制通用 UART 核、板级包装、板载 USB-UART 和时钟/复位之间的候选接口需求。"),
            sec("2 引用文档", COMMON_REFS),
            sec("3 接口需求", table(["标识", "接口", "需求", "状态"], [
                ["UART-IRS-001", "核时钟/复位", "`clk` 100 MHz 上升沿，`rst` 同步高有效；VC709 200 MHz SYSCLK 经 MMCM 适配", "candidate implemented"],
                ["UART-IRS-002", "发送并行口", "`tx_data[7:0]`/`tx_start` 输入，`tx_busy`/`tx_done` 输出；忙时不接受新请求", "candidate"],
                ["UART-IRS-003", "接收并行口", "`rx_data[7:0]`/`rx_done`/`frame_err` 输出；完成/错误指示为单拍", "candidate"],
                ["UART-IRS-004", "串行线", "`txd` 输出、`rxd` 输入；9600 8N1 基线，115200 8N1 扩展回归", "candidate"],
                ["UART-IRS-005", "USB-UART/管脚", "按 UG887 v1.6 与已入库 XTP213/Master XDC 交叉确认 CP2103 TX/RX、SYSCLK、CPU_RESET 和 IOSTANDARD", "candidate implemented"],
            ])),
            sec("4 质量与合格性", ASSURANCE, BLOCKED_HW),
            sec("5 需求可追踪性", "UART-IRS-001～005 应追踪到 PLDSDTD/PLDSRS、PLDSDD 接口设计、RTL 端口、XDC 约束来源和确认测试用例。"),
            sec("6 注释", "本文档是候选 IRS；板级事实未闭合前不建立接口基线。"),
        ],
    },
    {
        "number": 10, "id": "UART-DOC-010", "acronym": "IDD", "name": "UART 板级与逻辑接口设计说明",
        "sections": [
            sec("1 范围", PROJECT_FACTS, "接口设计采用通用核与板级包装分层，使核级仿真不依赖未确认的板卡管脚。"),
            sec("2 引用文档", COMMON_REFS),
            sec("3 接口设计决策", table(["决策", "设计", "理由/边界"], [
                ["UART-IDD-001", "`uart_top` 仅保留参数化数字接口", "便于 9600/115200 回归和跨板复用"],
                ["UART-IDD-002", "`uart_board_top` 负责差分时钟/MMCM、复位同步和 CP2103 UART 回显", "UG887/XTP213/Master XDC 交叉核对已完成，实物复核待办"],
                ["UART-IDD-003", "`rxd` 经两级 `ASYNC_REG` 同步后进入功能逻辑", "中等保证必做 CDC 评审"],
                ["UART-IDD-004", "波特 tick 作同步时钟使能，不产生派生时钟", "简化 STA 和 CDC 边界"],
            ])),
            sec("4 接口详细设计", "标准数字接口语义见 UART-DOC-002。VC709 候选约束为 SYSCLK H19/G18 DIFF_SSTL15、CPU_RESET AV40 LVCMOS18、UART TX/RX AU36/AU33 LVCMOS18、CFGBVS=GND、CONFIG_VOLTAGE=1.8；异步 UART 只约束同步器边界，不编造同步 I/O delay。", BLOCKED_HW),
            sec("5 需求可追踪性", table(["IRS", "IDD", "实现/验证"], [["UART-IRS-001～004", "UART-IDD-001/003/004", "`uart_top.v`、9600/115200 XSim、CDC/STA"], ["UART-IRS-005", "UART-IDD-002", "`uart_board_top.v`、`uart.xdc`、预码流实现；实物测试 blocked"]])),
            sec("6 注释", "板级候选值已由 UG887 v1.6、已入库 XTP213 原理图和官方 Master XDC 交叉核对；实物板卡修订和板测仍待人工确认。"),
        ],
    },
    {
        "number": 11, "id": "UART-DOC-011", "acronym": "PLDSFARAR", "name": "UART 收发器可编程逻辑器件软件可行性和风险分析报告",
        "sections": [
            sec("1 范围", PROJECT_FACTS), sec("2 引用文档", COMMON_REFS),
            sec("3 需求分析", "UART 只需小规模 RTL。VC709 候选板级输入、精确 part、仿真、综合、布局布线、CDC、DRC 和 STA 已形成探索性证据；供货、功耗、温压、辐照和实物确认仍未闭合。"),
            sec("4 可行性分析", table(["项目", "当前证据", "结论"], [["功能/结构", "五个 RTL 模块与两种波特率自检 TB", "核级候选可行"], ["资源", "690T 实现 55 LUT/62 FF、0 BRAM/DSP", "资源候选可行"], ["工具/part", "Connector/Vivado 2021.1 精确返回并实现 `xc7vx690tffg1761-2`", "工具链候选可行"], ["板级", "UG887 v1.6 + 已入库 XTP213/Master XDC", "约束候选已交叉核对；实物复核待办"], ["功耗/温压/辐照", "无系统级指标", "阻塞/待裁剪审定"]])),
            sec("5 必要性分析", "通用 UART 核适合作为 Synthia 的最小闭环参考：包含异步输入、状态机、参数化时序、异常恢复和板级约束边界。"),
            sec("6 继承性分析", "现有 RTL/TB 可继承为核级候选；历史 K70T 综合/STA 不能继承为 690T 器件级证据，旧 XDC 不能继承为新板级约束。"),
            sec("7 风险分析", table(["风险", "可能性/影响", "预防措施", "意外计划"], [["工具 profile 漂移", "低/高", "冻结精确 part/profile/输入哈希", "重新 query/validate/implement"], ["实物板卡修订与入库 Rev 1.0 不一致", "中/高", "硬件责任人核对 PCB 标识和受控资料", "保持 bitstream/板测阻塞并对应修订重做约束复核"], ["115200 参数边界", "低/中", "参数化判据与全量回归", "改用分数分频/过采样设计"], ["Agent 冒充批准", "中/高", "全部文档标记 candidate，批准走不可变记录", "拒绝基线/发布"]])),
        ],
    },
    {
        "number": 12, "id": "UART-DOC-012", "acronym": "SDP", "name": "UART 收发器软件开发计划",
        "sections": [
            sec("1 范围", PROJECT_FACTS, "本计划对开发、支持、管理和审查活动给出候选安排，不代表已获批的合同进度。"),
            sec("2 引用文档", COMMON_REFS),
            sec("3 软件开发概述", "生存周期采用需求—设计—实现/单元验证—集成/确认—交付的阶段化模型，各门只冻结受控快照。"),
            sec("4 组织和责职", ROLES),
            sec("5 软件开发活动", table(["活动", "主要产出", "入口/出口"], [["需求分析", "PLDSDTD/IRS/PLDSRS", "板级未知项显式阻塞"], ["设计", "IDD/PLDSDD", "接口、CDC、时序与验证设计受审"], ["实现/单元验证", "RTL/TB/PLDSSTP/STD/STR", "9600 + 115200 已形成候选实证；覆盖与独立验证待办"], ["工具链实证", "综合/实现/DRC/STA 证据", "精确 690T part/profile 已完成 exploratory 验证，正式复现仍需受控快照"], ["板级确认", "PLDSVTP/VTD/VTR", "XTP213/Master XDC 交叉核对已完成，实物修订与仪器完整后进入"]])),
            sec("6 进度和控制节点", table(["节点", "候选出口", "状态"], [["G1", "任务/风险/需求输入已审", "pending"], ["G2", "需求/接口基线候选", "pending"], ["G3", "设计/RTL/TB 及追踪已审", "pending"], ["G4", "验证、工具证据和发布输入已闭合", "blocked by coverage/independent review/board/approval"]])),
            sec("7 资源、风险和测量", "人员工时、设备和合同日期尚无批准数据。度量至少包含需求/追踪覆盖、用例执行、代码/功能覆盖、问题关闭、资源和时序余量。"),
            sec("8 配置、质量、保密和分承制方", "SCMP 和 SQAP 独立编制。当前无已识别分承制方；数据分类和保密方案待项目负责人/保密角色确定。"),
            sec("9 注释", "本 SDP 未合并 SCMP/SQAP，避免在未批准时隐藏专业责任。"),
        ],
    },
    {
        "number": 13, "id": "UART-DOC-013", "acronym": "SCMP", "name": "UART 收发器软件配置管理计划",
        "sections": [
            sec("1 范围", PROJECT_FACTS), sec("2 引用文档", COMMON_REFS), sec("3 组织和职责", ROLES),
            sec("4 软件配置管理活动", table(["活动", "要求", "记录"], [["配置标识", "源码、TB、XDC、文档、工具 profile 和板级输入使用唯一标识/版本/SHA-256", "ArtifactRevision/manifest"], ["配置控制", "变更需要来源、影响分析、授权决定和回归", "change/approval"], ["状态记实", "candidate/in_review/approved 和 exploratory/formal 严格分离", "event/status"], ["配置审核", "基线前复核完整性、哈希、追踪、问题和权限", "audit record"], ["发行/交付", "只允许获批产品基线和证据清单进入发布", "SVD/SPS/delivery manifest"]])),
            sec("5 工具、技术和方法", "Git 保留内容寻址历史，Core 保留 Artifact/Revision/Snapshot/Approval 结构化事实，Connector 保留 ToolRun 和 EvidenceManifest。不用 Markdown 状态冒充批准对象。"),
            sec("6 对供货单位的控制", "本节无已确认供货单位内容，因当前未识别分承制方；引入板卡/IP/工具供应方后补充版本、许可、完整性和交付控制。"),
            sec("7 进度表", "配置标识随首次产出建立；每次门审前执行状态记实与配置审核；发布时生成 SPS/SVD/SCMR 和交付清单。"),
            sec("8 注释", "配置管理角色人选和批准权限待项目负责人确认。"),
        ],
    },
    {
        "number": 14, "id": "UART-DOC-014", "acronym": "SQAP", "name": "UART 收发器软件质量保证计划",
        "sections": [
            sec("1 范围", PROJECT_FACTS), sec("2 引用文档", COMMON_REFS), sec("3 组织和职责", ROLES),
            sec("4 标准、条例和约定", "优先按 GJB 9432/9433/9764 和 GJB 438B/5235 的项目适用条款执行；GB/T 8566-2022 未同步入库前，不做依赖其全文的符合性结论。"),
            sec("5 活动审核", table(["活动", "审核要点", "独立角色"], [["需求/设计", "唯一标识、可验证性、追踪、板级未知项", "需求+独立 V&V"], ["RTL/CDC", "两级同步、FSM 恢复、参数边界", "PLDS 设计+独立 V&V"], ["测试/覆盖", "9600/115200、错帧、容差、分母/排除规则", "验证+质量"], ["工具证据", "精确 part/profile/hash、DRC/STA/资源、原始证据", "验证+配置"], ["门审/发布", "快照、问题、独立结论、人类批准", "质量+发布批准人"]])),
            sec("6 工作产品审核", "审核对象包含 22 类标准文档的适用/裁剪记录、RTL/TB/XDC、ToolRun/Evidence、追踪矩阵和发布清单。"),
            sec("7 不符合问题解决", "每个问题记录来源、影响、根因、责任人、处置、回归、独立复核和关闭决定；Agent 不能自行关闭需人类裁决的问题。"),
            sec("8 工具、技术和方法", "使用确定性文档检查、单元/回归测试、Vivado Connector、哈希清单和不可变批准记录。"),
            sec("9 对供货单位的控制", "当前无已识别供货单位，因此本节无实施记录；后续引入时按 SCMP/SQAP 统一管理。"),
            sec("10 记录的收集、维护和保存", "原始日志、波形、覆盖、报告、评审意见和批准对象以内容哈希、时间和身份关联；保存期限待合同/档案制度确定。"),
            sec("11 注释", ASSURANCE),
        ],
    },
    {
        "number": 15, "id": "UART-DOC-015", "acronym": "STrP", "name": "UART 收发器软件移交计划",
        "sections": [
            sec("1 范围", "本计划仅定义候选移交结构；当前无获批产品基线、受方或移交日期，不得宣称已移交。"), sec("2 引用文档", COMMON_REFS),
            sec("3 软件保障资源", "候选保障集包括 RTL/TB/XDC、22 类文档的适用集、工具 profile、构建/回归命令、证据清单、板级资料和问题清单。"),
            sec("4 推荐规程", "受方先验证哈希/签名，再在支持精确 690T part 的 Vivado profile 上重建，复核 DRC/STA/资源，最后按 PLDSVTP/VTD 执行板级回归。"),
            sec("5 培训", "至少覆盖文档状态语义、工作区/基线、Connector 证据、回归和板级固化/恢复。课程、人数和日期待移交双方确定。"),
            sec("6 预期更改区域", "主要可变区域为板级包装/XDC、目标 part/profile、UART 参数、复位适配和实物测试脚本；通用核变更必须执行完整回归和影响分析。"),
            sec("7 移交计划", table(["活动", "责任方", "出口", "状态"], [["基线审核", "配置+质量+发布", "获批发布快照", "pending"], ["交付校验", "双方", "哈希与清单一致", "pending"], ["环境重建", "受方", "精确 690T profile 可复现综合/预码流实现", "candidate demonstrated; formal transfer pending"], ["板级验收", "硬件+验证+需方", "PLDSVTR", "blocked by schematic archive/physical board/approval"]])),
            sec("8 注释", "本计划未给出虚构受方、地点、日期或签名。"),
        ],
    },
]


def add_remaining_docs() -> None:
    DOCS.extend([
        {
            "number": 16, "id": "UART-DOC-016", "acronym": "PLDSVTP", "name": "UART 收发器可编程逻辑器件软件确认测试计划",
            "sections": [sec("1 范围", PROJECT_FACTS, "本计划定义实物确认测试的结构；XTP213/Master XDC 交叉核对已完成，但无实物板卡修订确认/仪器/批准输入，当前仍为 blocked candidate。"), sec("2 引用文档", COMMON_REFS), sec("3 测试要求与测试策略", ASSURANCE, "拟采用实物串口分析仪/对端、回环、异常帧、长稳和复位/掉电恢复，并对 9600 与 115200 分别执行。"), sec("4 确认测试环境", BLOCKED_HW, "还需记录实物板卡修订、已批 bitstream 哈希、受控 Vivado/Connector profile、供电、线缆、对端和仪器校准信息。"), sec("5 测试内容", table(["测试项", "内容", "状态"], [["VTI-001", "9600 8N1 双向基线", "blocked"], ["VTI-002", "115200 8N1 扩展回归", "blocked"], ["VTI-003", "错帧/持续低/恢复", "blocked"], ["VTI-004", "复位、掉电、重配置", "blocked"], ["VTI-005", "长稳、吞吐、丢帧和时序余量", "blocked"]])), sec("6 测试进度", "预码流候选入口已满足：精确 part/profile、候选 XDC 与已路由实现均有证据，XTP213/Master XDC 已交叉核对；实物确认仍须取得板卡修订确认/仪器/已批 bitstream 并批准测试说明。"), sec("7 可追踪性", "VTI-001～005 须追踪 PLDSRS/IRS 需求、PLDSDD/IDD 设计和 PLDSVTD 用例。")],
        },
        {
            "number": 17, "id": "UART-DOC-017", "acronym": "PLDSVTD", "name": "UART 收发器可编程逻辑器件软件确认测试说明",
            "sections": [sec("1 范围", "本说明为 blocked candidate，不是可执行的批准用例集。"), sec("2 引用文档", COMMON_REFS), sec("3 确认测试环境", BLOCKED_HW), sec("4 测试说明", table(["用例", "涉及需求", "先决/输入", "预期结果/判据", "状态"], [["VTC-001", "基线收发", "已批 bitstream；9600 8N1 对端", "字节/顺序一致，无错帧", "blocked"], ["VTC-002", "扩展波特率", "115200 8N1 对端", "连续流量无丢帧", "blocked"], ["VTC-003", "异常恢复", "可控错停止位/持续低", "仅报错，恢复后正常", "blocked"], ["VTC-004", "复位/重配置", "可控复位与上电", "TX 空闲高，无伪字节", "blocked"]]), "每个用例执行前还须补充精确步骤、测试数据、仪器设置、终止条件和假设/约束，并经验证/质量审核。"), sec("5 可追踪性", "VTC-001～004 当前仅与 VTI 和候选需求建立 planned 关系，执行覆盖为 0。")],
        },
        {
            "number": 18, "id": "UART-DOC-018", "acronym": "PLDSVTR", "name": "UART 收发器可编程逻辑器件软件确认测试报告",
            "sections": [sec("1 范围", "本报告为未执行/blocked 状态记录，不宣称任何确认测试通过。"), sec("2 引用文档", COMMON_REFS), sec("3 测试概述", "未执行。原因：" + BLOCKED_HW), sec("4 详细测试结果", table(["项目", "计划", "已执行", "通过", "失败", "阻塞"], [["实物确认用例", "4", "0", "0", "0", "4"]]), "没有实物测试环境、原始板测数据、仪器记录、问题单或回归结果可报告。"), sec("5 评估和建议", "不具备全面评估、板级可用性、确认通过或交付的证据。精确 part/profile、预码流实现和 XTP213/Master XDC 交叉核对已完成候选验证；下一步应取得实物板卡修订确认、仪器和已批 bitstream，再批准 PLDSVTP/VTD 并执行。"), sec("附录 A 测试执行结果记录表", "本附录无执行记录，原因是确认测试尚未开始。"), sec("附录 B 问题报告单", "本附录无实物测试问题单；阻塞输入记录于 UART-DOC-000。")],
        },
        {
            "number": 19, "id": "UART-DOC-019", "acronym": "SPS", "name": "UART 收发器软件产品规格说明",
            "sections": [sec("1 范围", "本 SPS 描述当前候选产品结构；无获批产品基线或可交付 bitstream。"), sec("2 引用文档", COMMON_REFS), sec("3 需求", table(["类别", "候选内容", "状态"], [["源文件", "`rtl/*.v`、`tb/*.sv`、候选 VC709 XDC", "candidate"], ["文档", "22 类适用文档 + 3 份支撑文档", "candidate"], ["配置文件", "精确 Vivado/Connector profile 和已确认 part", "verified exploratory candidate"], ["可执行/配置数据", "bitstream 及编程/验证记录", "blocked"]])), sec("4 合格性规定", "逐项比对清单、文件长度和 SHA-256；在精确 part/profile 上可复现综合/预码流实现/DRC/STA；依获批 PLDSVTP/VTD 完成板级确认。"), sec("5 软件支持信息", "已实现 `uart_top` 通用核、`uart_board_top` 板级包装、TX/RX FSM、分频使能、MMCM 和复位同步。建立规程须指定精确输入哈希、top、part、约束和工具 profile；修改规程必须执行影响分析和全量回归。"), sec("6 需求可追踪性", "产品文件应追踪到设计单元、源文件、工具证据、资源测量和需求限值。"), sec("7 注释", "当前不得将候选清单称为产品基线。")],
        },
        {
            "number": 20, "id": "UART-DOC-020", "acronym": "SVD", "name": "UART 收发器软件版本说明",
            "sections": [sec("1 范围", "本文档是候选版本说明，不是已发布 SVD。"), sec("2 引用文档", COMMON_REFS), sec("3 版本说明", table(["属性", "候选值"], [["版本", VERSION], ["预期接收者", "待项目负责人确定"], ["内容", "RTL/TB/XDC/文档/VC709 预码流证据索引"], ["相对上版变更", "固定 VC709/`xc7vx690tffg1761-2`；增加板级包装、115200 XSim、综合和预码流实现证据；补齐 Word 文档"], ["已知问题", "无实物板卡修订确认/覆盖/独立验证/产品基线/bitstream/板测；XTP213/Master XDC 已入库交叉核对"], ["安装", "不可安装/固化，待批准发布文档" ]]), "发布材料清单、校验和安装判据须由配置/发布角色在获批基线后重新生成。"), sec("4 注释", "本文档没有伪造发布号、签名、交付日期或安装成功结论。")],
        },
        {
            "number": 21, "id": "UART-DOC-021", "acronym": "PLDSUD", "name": "UART 收发器可编程逻辑器件软件使用说明",
            "sections": [sec("1 范围", PROJECT_FACTS, "当前支持核级仿真、候选板级包装审查和预码流实现复现，不支持板级固化或装备运行。"), sec("2 引用文档", COMMON_REFS), sec("3 功能概述", "全双工 8N1 UART，TX 将并行字节转换为 LSB-first 串行帧，RX 对异步输入同步后中点采样并报告错停止位；VC709 包装以 115200 bit/s 对 CP2103 进行字节回显。"), sec("4 主要技术指标", table(["指标", "值/状态"], [["时钟", "VC709 200 MHz 差分 SYSCLK 经 MMCM 生成 100 MHz 核时钟"], ["波特率", "9600 与 115200 均完成 XSim 10/10 候选回归"], ["帧", "8 数据位、无校验、1 停止位"], ["目标器件", "`xc7vx690tffg1761-2`；Vivado 2021.1 精确查询并完成预码流实现"], ["功耗/温压/辐照", "未提供/阻塞"]])), sec("5 物理特性", BLOCKED_HW), sec("6 使用说明", "核级使用：在 `tx_busy=0` 时以单拍 `tx_start` 提交 `tx_data`；捕获 `tx_done`、`rx_done`、`frame_err` 单拍。仿真可参数化选择 9600/115200。板级候选包装将 CP2103 接收字节以 115200 bit/s 回显。"), sec("7 固化", "本章无可执行固化步骤，因为尚无实物板卡修订确认、已批 bitstream 和验收规程；XTP213/Master XDC 已入库交叉核对。本轮明确停在码流生成前；固化前须补充操作、校验、回退和恢复规程。")],
        },
        {
            "number": 22, "id": "UART-DOC-022", "acronym": "PLDSDSR", "name": "UART 收发器可编程逻辑器件软件研制总结报告",
            "sections": [sec("1 范围", "本文档为阶段性候选总结，项目未收尾，不得作为正式交付结论。"), sec("2 任务来源与可编程逻辑器件软件研制依据", PROJECT_FACTS, "任务来源是 Synthia Golden 参考项目建设；真实装备合同和系统任务书未提供。"), sec("3 可编程逻辑器件软件概述", "通用 UART 核、参数化分频、TX/RX FSM、两级 RX 同步、VC709 时钟/复位/CP2103 包装和自检 TB。"), sec("4 可编程逻辑器件软件研制过程", "已完成候选需求/设计、RTL/TB/XDC 修正，并在真实 Connector/Vivado 2021.1 上经 Mac→66 直连完成精确 part 查询、源码校验、9600/115200 XSim、综合和停在码流前的布局布线及报告。"), sec("5 满足任务指标情况", "9600 与 115200 均为 10/10 PASS；修订后 `DIFF_SSTL15` 的 690T 预码流实现 DRC 0 违规、WNS/WHS 为正、资源满足候选限值；XTP213/Master XDC 已入库交叉核对。覆盖、独立验证、批准和板测未闭合。"), sec("6 可编程逻辑器件软件测试", "行为仿真与工具报告见 UART-DOC-006 及 `evidence/vc709-prebit-20260828-diff-sstl15`；2026-08-27 包仅保留为修订前历史，实物确认为 0 执行/blocked。"), sec("7 质量保证情况", "已补齐候选 SQAP 和文档结构；独立质量审核和人类批准未执行。"), sec("8 配置管理情况", "使用 Git/SHA-256/manifest 保留候选身份；无获批产品基线。"), sec("9 可靠性、安全性分析", ASSURANCE), sec("10 测量与分析", "VC709/690T exploratory（修订后 direct）结果：9600 10/10、115200 10/10；55 LUT、62 FF、0 BRAM/DSP；methodology 0 违规；CDC 仅两级 ASYNC_REG 同步器的 CDC-3 Info ×1；DRC 0 违规；WNS 7.630 ns、WHS 0.093 ns、TNS/THS 0；未生成 bitstream。"), sec("11 结论", "当前可以结论“VC709/690T 候选已走通至码流生成前，具备继续人工评审和板级准备的技术基础”，但不能结论“符合、验收、可交付或可使用”。")],
        },
        {
            "number": 23, "id": "UART-DOC-023", "acronym": "SCMR", "name": "UART 收发器软件配置管理报告",
            "sections": [sec("1 范围", "本报告记录当前候选配置状态，不冒充已批基线或发布报告。"), sec("2 引用文档", COMMON_REFS), sec("3 配置管理情况综述", "已使用 Git 和 SHA-256 管理仓库候选，当前无获批产品基线、发布或交付。"), sec("4 基本信息", table(["属性", "值"], [["项目", "GOLDEN-UART"], ["候选版本", VERSION], ["目标", "VC709 / `xc7vx690tffg1761-2`；精确 part/profile 已完成 exploratory 验证"], ["配置库", "Git + manifest.sha256"]])), sec("5 专业组和权限", ROLES), sec("6 配置项记录", "候选配置项包含 RTL/TB/XDC/文档/标准参考集、project-profile.json 和 VC709 预码流证据；精确列表以 manifest 和 Git tree 为准。"), sec("7 变更记录", "本版主要变更为固定 VC709/690T、加入板级包装与 115200 回归、完成预码流实现证据，并同步关键性/保证、全角色和 Word 文档。"), sec("8 基线记录", "本章无内容，因为当前没有获授权人类批准的 B0/B1/B2 或产品基线。"), sec("9 入库记录", "仓库提交和标准参考集已记录；正式配置库入库权限/单据待确定。"), sec("10 出库记录", "本章无内容，因未发生正式出库或交付。"), sec("11 审核记录", "有 Agent 自检记录，无独立配置审核和问题关闭批准。"), sec("12 备份记录", "仓库备份、保存期限和恢复演练尚未提供受控记录。"), sec("13 测量", "报告应统计配置项/基线/变更/审核/备份和问题关闭；当前仅报告候选文件、哈希和 exploratory ToolRun 完整性。"), sec("14 注释", "本报告不代替 Core 中的结构化配置事实。")],
        },
        {
            "number": 24, "id": "UART-DOC-024", "acronym": "SQAR", "name": "UART 收发器软件质量保证报告",
            "sections": [sec("1 范围", "本报告是阶段性候选质量状态记录，无独立质量角色签署。"), sec("2 引用文档", COMMON_REFS), sec("3 软件研制概述", PROJECT_FACTS), sec("4 软件质量保证情况", table(["活动", "当前情况", "结论边界"], [["文档审查", "已按 GJB 9764/438B 补齐 22 类 Word 候选及 3 份支撑文档", "待标准/质量独立审核"], ["代码/设计审查", "已有 Agent 自检和历史缺陷整改", "不替代独立评审"], ["仿真测试", "VC709/690T exploratory：9600 10/10、115200 10/10", "不是 formal/批准运行"], ["覆盖", "未采集批准代码/功能覆盖", "未闭合"], ["690T 工具证据", "精确 part/profile、综合、预码流实现、methodology/CDC/DRC/STA 已验证", "exploratory candidate；待独立复核/批准"], ["实物确认", "0 执行", "blocked"]])), sec("5 软件配置管理情况", "候选文件使用 Git/SHA-256/manifest；无获批基线、发布或交付。"), sec("6 第三方评测情况", "本章无内容，因未发生第三方评测；不得用 Agent 或外部模型自检冒充第三方结论。"), sec("7 注释", ASSURANCE, "当前质量结论为 review_required，不是通过。")],
        },
    ])


def build_markdown(spec: dict[str, object]) -> str:
    title = f"{spec['name']}（{spec['acronym']}）"
    sections = spec["sections"]
    assert isinstance(sections, list)
    toc = "\n".join(f"{i}. {item[0].split(' ', 1)[1] if ' ' in item[0] else item[0]}" for i, item in enumerate(sections, 1))
    cover = table(["属性", "内容"], [
        ["文档标识及版本", f"{spec['id']} / {VERSION}"],
        ["数据分类", "待项目责任人确定；当前按非公开工程资料处理"],
        ["编制/修订日期", DATE],
        ["文档名称", str(spec["name"])],
        ["编制单位", "Synthia Golden 候选项目（待授权单位确认）"],
        ["编写", "Agent 辅助拟制，待授权角色署名"],
        ["审核", "待相应技术/验证/质量角色审核"],
        ["批准", "未批准；待项目负责人或授权批准人决定"],
    ])
    change = table(["版本", "日期", "修改内容", "修改人"], [[VERSION, DATE, f"按适用标准补齐 {spec['acronym']} Word 候选，并纳入 690T/保证/角色决策", "Agent 辅助拟制，待授权角色确认"]])
    body: list[str] = [f"# {title}", "", "## 封面", "", cover, "", "## 修改页", "", change, "", "## 目录", "", toc]
    for heading, blocks in sections:
        body.extend(["", f"## {heading}", ""])
        for block in blocks:
            body.extend([block, ""])
    body.extend(["## 候选与批准声明", "", "本文档由 Synthia 辅助拟制，只是 candidate。未经具有对应授权的人类角色审核、批准并绑定冻结快照前，不得解释为获批基线、符合性结论、测试通过或交付许可。", ""])
    return "\n".join(body)


def set_cell_text(cell, text: str, bold: bool = False) -> None:
    cell.text = ""
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(0)
    add_inline_runs(p, text, size=9, force_bold=bold)
    cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER


def set_run_font(run, name: str, size: float, *, bold: bool | None = None, color: str | None = None) -> None:
    run.font.name = name
    run._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), name)
    run._element.get_or_add_rPr().rFonts.set(qn("w:ascii"), name)
    run._element.get_or_add_rPr().rFonts.set(qn("w:hAnsi"), name)
    run._element.get_or_add_rPr().rFonts.set(qn("w:cs"), name)
    run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if color:
        run.font.color.rgb = RGBColor.from_string(color)


def add_inline_runs(paragraph, text: str, *, size: float = 11, force_bold: bool = False) -> None:
    """Render the small Markdown subset used by the controlled sources."""
    cursor = 0
    for match in re.finditer(r"(`[^`]+`|\*\*[^*]+\*\*)", text):
        if match.start() > cursor:
            run = paragraph.add_run(text[cursor:match.start()])
            set_run_font(run, "Songti SC", size, bold=force_bold)
        token = match.group(0)
        if token.startswith("`"):
            run = paragraph.add_run(token[1:-1])
            set_run_font(run, "Courier New", max(size - 0.5, 8), bold=force_bold, color="1F3A5F")
        else:
            run = paragraph.add_run(token[2:-2])
            set_run_font(run, "Songti SC", size, bold=True)
        cursor = match.end()
    if cursor < len(text):
        run = paragraph.add_run(text[cursor:])
        set_run_font(run, "Songti SC", size, bold=force_bold)


def add_numbering_definition(doc: Document, *, abstract_id: int, num_id: int, ordered: bool) -> None:
    """Install one compact-reference-guide numbering definition."""
    numbering = doc.part.numbering_part.element
    abstract = OxmlElement("w:abstractNum")
    abstract.set(qn("w:abstractNumId"), str(abstract_id))
    multi = OxmlElement("w:multiLevelType")
    multi.set(qn("w:val"), "singleLevel")
    abstract.append(multi)
    level = OxmlElement("w:lvl")
    level.set(qn("w:ilvl"), "0")
    start = OxmlElement("w:start")
    start.set(qn("w:val"), "1")
    level.append(start)
    num_fmt = OxmlElement("w:numFmt")
    num_fmt.set(qn("w:val"), "decimal" if ordered else "bullet")
    level.append(num_fmt)
    level_text = OxmlElement("w:lvlText")
    level_text.set(qn("w:val"), "%1." if ordered else "•")
    level.append(level_text)
    level_jc = OxmlElement("w:lvlJc")
    level_jc.set(qn("w:val"), "left")
    level.append(level_jc)
    p_pr = OxmlElement("w:pPr")
    tabs = OxmlElement("w:tabs")
    tab = OxmlElement("w:tab")
    tab.set(qn("w:val"), "num")
    tab.set(qn("w:pos"), "540")
    tabs.append(tab)
    p_pr.append(tabs)
    ind = OxmlElement("w:ind")
    ind.set(qn("w:left"), "540")
    ind.set(qn("w:hanging"), "271")
    p_pr.append(ind)
    spacing = OxmlElement("w:spacing")
    spacing.set(qn("w:after"), "80")
    spacing.set(qn("w:line"), "300")
    spacing.set(qn("w:lineRule"), "auto")
    p_pr.append(spacing)
    level.append(p_pr)
    abstract.append(level)
    numbering.append(abstract)
    num = OxmlElement("w:num")
    num.set(qn("w:numId"), str(num_id))
    abstract_ref = OxmlElement("w:abstractNumId")
    abstract_ref.set(qn("w:val"), str(abstract_id))
    num.append(abstract_ref)
    numbering.append(num)


def apply_numbering(paragraph, num_id: int) -> None:
    p_pr = paragraph._p.get_or_add_pPr()
    num_pr = OxmlElement("w:numPr")
    ilvl = OxmlElement("w:ilvl")
    ilvl.set(qn("w:val"), "0")
    num_pr.append(ilvl)
    num_id_node = OxmlElement("w:numId")
    num_id_node.set(qn("w:val"), str(num_id))
    num_pr.append(num_id_node)
    p_pr.append(num_pr)


def shade_cell(cell, fill: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_margins(cell, top: int = 80, start: int = 120, bottom: int = 80, end: int = 120) -> None:
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for side, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn(f"w:{side}"))
        if node is None:
            node = OxmlElement(f"w:{side}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_table_geometry(word_table, widths: list[int], indent: int = 120) -> None:
    table = word_table._tbl
    tbl_pr = table.tblPr
    tbl_w = tbl_pr.find(qn("w:tblW"))
    if tbl_w is None:
        tbl_w = OxmlElement("w:tblW")
        tbl_pr.append(tbl_w)
    tbl_w.set(qn("w:w"), str(sum(widths)))
    tbl_w.set(qn("w:type"), "dxa")
    tbl_ind = tbl_pr.find(qn("w:tblInd"))
    if tbl_ind is None:
        tbl_ind = OxmlElement("w:tblInd")
        tbl_pr.append(tbl_ind)
    tbl_ind.set(qn("w:w"), str(indent))
    tbl_ind.set(qn("w:type"), "dxa")
    grid = table.tblGrid
    for child in list(grid):
        grid.remove(child)
    for width in widths:
        col = OxmlElement("w:gridCol")
        col.set(qn("w:w"), str(width))
        grid.append(col)
    for row in word_table.rows:
        for index, cell in enumerate(row.cells):
            tc_w = cell._tc.get_or_add_tcPr().find(qn("w:tcW"))
            if tc_w is None:
                tc_w = OxmlElement("w:tcW")
                cell._tc.get_or_add_tcPr().append(tc_w)
            tc_w.set(qn("w:w"), str(widths[min(index, len(widths) - 1)]))
            tc_w.set(qn("w:type"), "dxa")
            set_cell_margins(cell)
    word_table.autofit = False


def style_document(doc: Document) -> None:
    section = doc.sections[0]
    section.page_width = Cm(21.0)
    section.page_height = Cm(29.7)
    section.top_margin = Cm(2.54)
    section.bottom_margin = Cm(2.54)
    section.left_margin = Cm(2.54)
    section.right_margin = Cm(2.54)
    section.header_distance = Cm(1.25)
    section.footer_distance = Cm(1.25)

    normal = doc.styles["Normal"]
    normal.font.name = "Songti SC"
    for font_key in ("eastAsia", "ascii", "hAnsi", "cs"):
        normal._element.rPr.rFonts.set(qn(f"w:{font_key}"), "Songti SC")
    normal.font.size = Pt(11)
    normal.paragraph_format.space_before = Pt(0)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.25

    for name, size, color, before, after in (
        ("Title", 22, "000000", 0, 16),
        ("Heading 1", 16, "2E74B5", 18, 10),
        ("Heading 2", 13, "2E74B5", 14, 7),
        ("Heading 3", 12, "1F4D78", 10, 5),
    ):
        style = doc.styles[name]
        style.font.name = "Songti SC"
        for font_key in ("eastAsia", "ascii", "hAnsi", "cs"):
            style._element.rPr.rFonts.set(qn(f"w:{font_key}"), "Songti SC")
        style.font.size = Pt(size)
        style.font.color.rgb = RGBColor.from_string(color)
        style.font.bold = name != "Title"
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.keep_with_next = True
    doc.styles["Title"].paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER

    for style_name in ("List Bullet", "List Number"):
        style = doc.styles[style_name]
        style.font.name = "Songti SC"
        for font_key in ("eastAsia", "ascii", "hAnsi", "cs"):
            style._element.rPr.rFonts.set(qn(f"w:{font_key}"), "Songti SC")
        style.font.size = Pt(11)
        style.paragraph_format.left_indent = Inches(0.375)
        style.paragraph_format.first_line_indent = Inches(-0.188)
        style.paragraph_format.space_after = Pt(4)
        style.paragraph_format.line_spacing = 1.25

    # compact_reference_guide with named A4/Songti SC overrides:
    # A4 210 x 297 mm, 25.4 mm margins, 9025 DXA usable width;
    # Songti SC is used for all scripts because it renders CJK reliably in Word/LibreOffice on macOS.
    add_numbering_definition(doc, abstract_id=90, num_id=90, ordered=False)
    add_numbering_definition(doc, abstract_id=91, num_id=91, ordered=True)


def add_page_number(paragraph) -> None:
    paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    run = paragraph.add_run("第 ")
    set_run_font(run, "Songti SC", 9, color="666666")
    fld_char = OxmlElement("w:fldChar")
    fld_char.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = " PAGE "
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run._r.append(fld_char)
    run._r.append(instr)
    run._r.append(end)
    suffix = paragraph.add_run(" 页")
    set_run_font(suffix, "Songti SC", 9, color="666666")


def add_table(doc: Document, rows: list[list[str]]) -> None:
    if not rows:
        return
    count = max(len(row) for row in rows)
    word_table = doc.add_table(rows=len(rows), cols=count)
    word_table.style = "Table Grid"
    total = 9025
    if count == 2:
        widths = [2256, 6769]
    elif count == 3:
        widths = [1805, 3610, 3610]
    elif count == 4:
        widths = [1354, 1805, 4059, 1807]
    elif count == 5:
        widths = [1200, 1800, 2100, 2725, 1200]
    elif count == 6:
        widths = [1800, 1445, 1445, 1445, 1445, 1445]
    else:
        base = total // count
        widths = [base] * count
        widths[-1] += total - sum(widths)
    for r_index, row in enumerate(rows):
        for c_index in range(count):
            text = row[c_index] if c_index < len(row) else ""
            set_cell_text(word_table.cell(r_index, c_index), text, bold=r_index == 0)
            if r_index == 0:
                shade_cell(word_table.cell(r_index, c_index), "E8EEF5")
    set_table_geometry(word_table, widths)
    if word_table.rows:
        tr_pr = word_table.rows[0]._tr.get_or_add_trPr()
        repeat = OxmlElement("w:tblHeader")
        repeat.set(qn("w:val"), "true")
        tr_pr.append(repeat)
    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_after = Pt(2)


def parse_table(lines: list[str], index: int) -> tuple[list[list[str]], int]:
    rows: list[list[str]] = []
    while index < len(lines) and lines[index].strip().startswith("|"):
        parts = [part.strip() for part in lines[index].strip().strip("|").split("|")]
        if not all(re.fullmatch(r":?-{3,}:?", part) for part in parts):
            rows.append(parts)
        index += 1
    return rows, index


def markdown_to_docx(markdown: str, output: Path) -> None:
    doc = Document()
    style_document(doc)
    lines = markdown.splitlines()
    title_text = next((line[2:].strip() for line in lines if line.startswith("# ")), output.stem)
    title = doc.add_paragraph(style="Title")
    title.add_run(title_text)

    header = doc.sections[0].header.paragraphs[0]
    header.text = "Synthia Golden | 受控候选文档"
    header.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    for run in header.runs:
        set_run_font(run, "Songti SC", 8.5, color="666666")
    add_page_number(doc.sections[0].footer.paragraphs[0])

    index = 0
    in_code = False
    code_lines: list[str] = []
    first_h1_skipped = False
    body_started = False
    while index < len(lines):
        raw = lines[index]
        stripped = raw.strip()
        if stripped.startswith("```"):
            if in_code:
                p = doc.add_paragraph()
                p.paragraph_format.left_indent = Cm(0.5)
                p.paragraph_format.space_after = Pt(6)
                run = p.add_run("\n".join(code_lines))
                set_run_font(run, "Songti SC", 8.5, color="1F3A5F")
                code_lines = []
                in_code = False
            else:
                in_code = True
            index += 1
            continue
        if in_code:
            code_lines.append(raw)
            index += 1
            continue
        if raw.startswith("# ") and not first_h1_skipped:
            first_h1_skipped = True
            index += 1
            continue
        if stripped == "---" or stripped == "":
            index += 1
            continue
        if stripped.startswith("## "):
            heading = stripped[3:].strip()
            if heading == "封面":
                index += 1
                continue
            if heading in ("修改页", "目录") or (re.match(r"^1\s", heading) and not body_started):
                doc.add_page_break()
                if re.match(r"^1\s", heading):
                    body_started = True
            doc.add_paragraph(heading, style="Heading 1")
            index += 1
            continue
        if stripped.startswith("### "):
            doc.add_paragraph(stripped[4:].strip(), style="Heading 2")
            index += 1
            continue
        if stripped.startswith("#### "):
            doc.add_paragraph(stripped[5:].strip(), style="Heading 3")
            index += 1
            continue
        if stripped.startswith("|"):
            rows, index = parse_table(lines, index)
            add_table(doc, rows)
            continue
        bullet = re.match(r"^[-*]\s+(.*)$", stripped)
        numbered = re.match(r"^\d+[.)]\s+(.*)$", stripped)
        if bullet:
            p = doc.add_paragraph(style="List Bullet")
            apply_numbering(p, 90)
            add_inline_runs(p, bullet.group(1))
        elif numbered:
            p = doc.add_paragraph(style="List Number")
            apply_numbering(p, 91)
            add_inline_runs(p, numbered.group(1))
        elif stripped.startswith("> "):
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.6)
            p.paragraph_format.right_indent = Cm(0.3)
            run = p.add_run(stripped[2:])
            set_run_font(run, "Songti SC", 9.5, color="555555")
        else:
            p = doc.add_paragraph()
            p.paragraph_format.first_line_indent = Cm(0.74)
            add_inline_runs(p, stripped)
        index += 1

    core_props = doc.core_properties
    core_props.title = title_text
    core_props.subject = "GOLDEN-UART GJB candidate document"
    core_props.author = "Synthia (candidate drafting assistant)"
    core_props.keywords = "candidate; GJB 9432; GJB 9764; UART; XC7VX690T"
    core_props.comments = (
        "Generated from controlled Markdown source; compact_reference_guide preset with named A4 and "
        "Songti SC font override; memo_masthead-style title plus metadata cover; human review and approval pending."
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    doc.save(output)


def main() -> None:
    add_remaining_docs()
    if len(DOCS) != 16:
        raise RuntimeError(f"expected 16 missing formal docs, got {len(DOCS)}")
    for spec in DOCS:
        filename = f"{int(spec['number']):02d}-{spec['name']}.md"
        (DOCS_DIR / filename).write_text(build_markdown(spec), encoding="utf-8")

    markdown_files = sorted(DOCS_DIR.glob("*.md"))
    if len(markdown_files) != 25:
        raise RuntimeError(f"expected 25 Markdown sources, got {len(markdown_files)}")
    WORD_DIR.mkdir(parents=True, exist_ok=True)
    for source in markdown_files:
        markdown_to_docx(source.read_text(encoding="utf-8"), WORD_DIR / f"{source.stem}.docx")
    print(f"built {len(markdown_files)} DOCX files in {WORD_DIR}")


if __name__ == "__main__":
    main()
