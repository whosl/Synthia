`timescale 1ns / 1ps
//============================================================================
// 模块名称 : baud_gen
// 功能描述 : 波特率节拍发生器。在 ce 有效期间，每隔 CLKS_PER_BIT 个系统
//            时钟周期产生一个 1 拍宽的 baud_tick 脉冲，供发送状态机用作
//            位时基准。接收状态机因需半位偏移采样，使用内部计数器，不复
//            用本模块。
// 时钟/复位 : clk 上升沿采样；rst 同步高有效复位。
// 参数关系 : CLKS_PER_BIT = floor(CLK_FREQ / BAUD_RATE)
//            100 MHz / 9600 = 10416.67 -> 10416（向下取整）
//            实际波特率 = 100 MHz / 10416 = 9600.61 bps，误差 +0.0064%。
//            采用向下取整是为了同时满足波特率误差与最低吞吐率要求。
//============================================================================
module baud_gen #(
    parameter CLK_FREQ  = 100_000_000, // 系统时钟频率 (Hz)
    parameter BAUD_RATE = 9600         // 目标波特率 (bps)
) (
    input  wire clk,                   // 系统时钟
    input  wire rst,                   // 同步复位，高有效
    input  wire ce,                    // 计数使能（发送期间有效）
    output wire baud_tick              // 位节拍使能，每 CLKS_PER_BIT 拍有效 1 拍
);

    function integer clog2;
        input integer value;
        integer work;
        begin
            work = value - 1;
            clog2 = 1;
            while (work > 1) begin
                work = work >> 1;
                clog2 = clog2 + 1;
            end
        end
    endfunction

    localparam integer CLKS_PER_BIT = CLK_FREQ / BAUD_RATE;
    localparam integer COUNTER_WIDTH = clog2(CLKS_PER_BIT);

    reg [COUNTER_WIDTH-1:0] counter;

    // 组合使能由寄存器化的 ce/counter 产生，状态机在同一时钟沿消费，
    // 避免把注册后的 tick 再延迟一拍而拉长位时间。
    assign baud_tick = ce && (counter == CLKS_PER_BIT - 1);

    always @(posedge clk) begin
        if (rst) begin
            counter <= {COUNTER_WIDTH{1'b0}};
        end else if (ce) begin
            if (baud_tick)
                counter <= {COUNTER_WIDTH{1'b0}};
            else
                counter <= counter + {{(COUNTER_WIDTH-1){1'b0}}, 1'b1};
        end else begin
            counter <= {COUNTER_WIDTH{1'b0}};
        end
    end

endmodule
