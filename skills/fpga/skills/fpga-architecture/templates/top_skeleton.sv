// ============================================================================
// NON_DELIVERABLE_SCAFFOLD — Synthia 架构阶段顶层骨架模板（不可登记为完成产物）
//
// 本文件是 fpga-architecture 的模板，仅用于勾勒参数、端口与黑盒例化位置。
// 使用约束：
//   - 凡保留本头注释、TODO 标记或零值占位 assign 的派生文件一律视为未完成
//     骨架，禁止作为 RTL 交付物登记，禁止通过 RTL 完成闸门；
//   - fpga-rtl-build 接管后必须：重命名模块（example_top 为占位名）、按
//     doc/arch/interface_contract.yaml 与 doc/arch/connection_matrix.md
//     例化并连接真实子模块、删除全部 TODO 与零值占位、重写本头部；
//   - 下方零值 assign 仅为让骨架可解析/可展开，不表达任何默认透传行为或
//     已确认行为契约；不得据此推断端口语义。
// ============================================================================

module example_top #(
    parameter int DATA_WIDTH = 32
) (
    input  logic                  clk_sys,
    input  logic                  rstn_sys,
    input  logic [DATA_WIDTH-1:0] s_data,
    input  logic                  s_valid,
    output logic                  s_ready,
    output logic [DATA_WIDTH-1:0] m_data,
    output logic                  m_valid,
    input  logic                  m_ready
);

    // TODO(arch): 按 doc/arch/connection_matrix.md 例化并连接子模块；
    //             完成前本文件不得登记为 RTL 交付候选。
    // TODO(arch): 骨架不假设任何默认透传行为；以下为占位，必须替换。

    // PLACEHOLDER(arch): 零值占位，仅保证骨架可展开；非已确认行为。
    assign s_ready = 1'b0;
    assign m_data  = '0;
    assign m_valid = 1'b0;

endmodule
