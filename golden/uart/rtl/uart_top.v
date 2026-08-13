`timescale 1ns / 1ps
//============================================================================
// 模块名称 : uart_top
// 功能描述 : UART 收发器顶层。例化 uart_tx 与 uart_rx，二者共享相同的时钟
//            与复位，独立的数据通路。典型应用中将 txd 直连 rxd 实现环回。
// 时钟/复位 : clk 上升沿；rst 同步高有效。
//============================================================================
module uart_top #(
    parameter CLK_FREQ  = 100_000_000,
    parameter BAUD_RATE = 9600
) (
    input  wire       clk,
    input  wire       rst,
    // ---- 发送接口 ----
    input  wire       tx_start,
    input  wire [7:0] tx_data,
    output wire       txd,
    output wire       tx_busy,
    output wire       tx_done,
    // ---- 接收接口 ----
    input  wire       rxd,
    output wire [7:0] rx_data,
    output wire       rx_done,
    output wire       frame_err
);

    uart_tx #(
        .CLK_FREQ (CLK_FREQ),
        .BAUD_RATE(BAUD_RATE)
    ) u_uart_tx (
        .clk      (clk),
        .rst      (rst),
        .tx_start (tx_start),
        .tx_data  (tx_data),
        .txd      (txd),
        .tx_busy  (tx_busy),
        .tx_done  (tx_done)
    );

    uart_rx #(
        .CLK_FREQ (CLK_FREQ),
        .BAUD_RATE(BAUD_RATE)
    ) u_uart_rx (
        .clk       (clk),
        .rst       (rst),
        .rxd       (rxd),
        .rx_data   (rx_data),
        .rx_done   (rx_done),
        .frame_err (frame_err)
    );

endmodule
