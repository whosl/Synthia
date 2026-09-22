// ─────────────────────────────────────────────────────────────────────────────
// alu8.v — 8 位组合逻辑 ALU（纯内部模块，无时钟/复位）
//
// 操作码（op[3:0]）：
//   0 ADD  result = a + b     carry = 第 8 位进位      overflow = 有符号加法溢出
//   1 SUB  result = a - b     carry = 借位（a < b）    overflow = 有符号减法溢出
//   2 AND  result = a & b     carry = 0               overflow = 0
//   3 OR   result = a | b     carry = 0               overflow = 0
//   4 XOR  result = a ^ b     carry = 0               overflow = 0
//   5 NOT  result = ~a        carry = 0               overflow = 0
//   6 SHL  result = a << 1    carry = 移出的 a[7]      overflow = 0
//   7 SHR  result = a >> 1    carry = 移出的 a[0]      overflow = 0
//   8~15   result = 0         carry = 0               overflow = 0（保留/非法码）
//   zero = (result == 8'h00)，对全部操作有效
// ─────────────────────────────────────────────────────────────────────────────

module alu8 (
    input  wire [7:0] a,         // 操作数 A
    input  wire [7:0] b,         // 操作数 B
    input  wire [3:0] op,        // 操作码
    output reg  [7:0] result,    // 运算结果
    output wire       zero,      // 结果为零标志
    output reg        carry,     // 进位/借位/移出位标志
    output reg        overflow   // 有符号溢出标志（仅 ADD/SUB 定义）
);

    localparam [3:0] OP_ADD = 4'd0;
    localparam [3:0] OP_SUB = 4'd1;
    localparam [3:0] OP_AND = 4'd2;
    localparam [3:0] OP_OR  = 4'd3;
    localparam [3:0] OP_XOR = 4'd4;
    localparam [3:0] OP_NOT = 4'd5;
    localparam [3:0] OP_SHL = 4'd6;
    localparam [3:0] OP_SHR = 4'd7;

    // 9 位扩展算术：第 8 位捕获进位/借位，避免隐式位宽截断
    wire [8:0] add_ext = {1'b0, a} + {1'b0, b};
    wire [8:0] sub_ext = {1'b0, a} - {1'b0, b};

    // 有符号溢出：ADD——两操作数同号而结果异号；SUB——两操作数异号而结果与 a 异号
    wire add_ovf = (a[7] == b[7]) && (add_ext[7] != a[7]);
    wire sub_ovf = (a[7] != b[7]) && (sub_ext[7] != a[7]);

    wire a_lt_b = (a < b);       // 无符号比较，用于 SUB 借位判定

    always @* begin
        result   = 8'h00;
        carry    = 1'b0;
        overflow = 1'b0;
        case (op)
            OP_ADD: begin
                result   = add_ext[7:0];
                carry    = add_ext[8];
                overflow = add_ovf;
            end
            OP_SUB: begin
                result   = sub_ext[7:0];
                carry    = a_lt_b;            // 借位约定：a < b 时 carry=1
                overflow = sub_ovf;
            end
            OP_AND: result = a & b;
            OP_OR:  result = a | b;
            OP_XOR: result = a ^ b;
            OP_NOT: result = ~a;
            OP_SHL: begin
                result = {a[6:0], 1'b0};
                carry  = a[7];                // 移出位
            end
            OP_SHR: begin
                result = {1'b0, a[7:1]};
                carry  = a[0];                // 移出位
            end
            default: begin
                result   = 8'h00;
                carry    = 1'b0;
                overflow = 1'b0;
            end
        endcase
    end

    assign zero = (result == 8'h00);

endmodule
