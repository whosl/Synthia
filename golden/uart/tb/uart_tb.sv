`timescale 1ns / 1ps
//============================================================================
// uart_tb.sv -- UART 收发器自检测试平台 (SystemVerilog)
//
// 验证流程：
//   1. 同步复位若干周期
//   2. 发送 0xA5，经环回 (txd -> rxd) 由接收侧校验
//   3. 发送边界码型 0x00 / 0xFF，验证全 0/全 1 数据位采样裕度
//   4. 发送交替码型 0x3C，覆盖 0/1 跳变
//   全部通过打印 PASS；任一字节不匹配或帧错误则 $fatal 终止。
//
// 仿真器：Vivado 2021.1 XSim。时钟 100 MHz，周期 10 ns。
//============================================================================
module uart_tb;

    localparam CLK_FREQ     = 100_000_000;
    localparam BAUD_RATE    = 9600;
    localparam CLKS_PER_BIT = (CLK_FREQ + (BAUD_RATE >> 1)) / BAUD_RATE; // 10417
    localparam CLK_PERIOD   = 10;   // ns，100 MHz

    reg        clk      = 1'b0;
    reg        rst      = 1'b1;
    reg        tx_start = 1'b0;
    reg  [7:0] tx_data  = 8'h00;
    wire       txd;
    wire       tx_busy;
    wire       tx_done;
    wire [7:0] rx_data;
    wire       rx_done;
    wire       frame_err;

    //---- 例化 DUT：发送输出环回到接收输入 ----
    uart_top #(
        .CLK_FREQ (CLK_FREQ),
        .BAUD_RATE(BAUD_RATE)
    ) dut (
        .clk       (clk),
        .rst       (rst),
        .tx_start  (tx_start),
        .tx_data   (tx_data),
        .txd       (txd),
        .tx_busy   (tx_busy),
        .tx_done   (tx_done),
        .rxd       (txd),    // 环回连接
        .rx_data   (rx_data),
        .rx_done   (rx_done),
        .frame_err (frame_err)
    );

    //---- 时钟产生 ----
    always #(CLK_PERIOD/2) clk = ~clk;

    //---- 发送一个字节并校验环回接收 ----
    task automatic send_and_check(input [7:0] data);
        begin
            @(posedge clk);
            tx_start <= 1'b1;
            tx_data  <= data;
            @(posedge clk);
            tx_start <= 1'b0;
            // 等待接收完成（rx_done 在停止位中点先于 tx_done 触发）
            @(posedge rx_done);
            #1; // 待 NBA 更新稳定后采样
            if ((rx_data !== data) || (frame_err !== 1'b0)) begin
                $display("FAIL: sent 0x%0h, got 0x%0h, frame_err=%0b",
                         data, rx_data, frame_err);
                $fatal(1, "UART loopback check failed");
            end else begin
                $display("OK:   sent 0x%0h, got 0x%0h", data, rx_data);
            end
            // 等待发送返回空闲，确保下一帧可启动
            @(posedge tx_done);
            @(posedge clk);
        end
    endtask

    //---- 主激励 ----
    initial begin
        // 复位（同步，高有效）：保持若干周期
        rst      = 1'b1;
        tx_start = 1'b0;
        tx_data  = 8'h00;
        repeat (5) @(posedge clk);
        rst = 1'b0;
        repeat (2) @(posedge clk);

        // 测试用例：0xA5（标称）、0x00（全 0 边界）、
        //           0xFF（全 1 边界）、0x3C（交替码型）
        send_and_check(8'hA5);
        send_and_check(8'h00);
        send_and_check(8'hFF);
        send_and_check(8'h3C);

        $display("PASS: all UART loopback tests passed (4/4 bytes)");
        $finish;
    end

    //---- 看门狗：防止挂死 ----
    initial begin
        #(CLK_PERIOD * CLKS_PER_BIT * 60); // 约 6.25 ms，足够 4 帧（4×1.04ms）
        $fatal(1, "ERROR: simulation timeout watchdog");
    end

endmodule
