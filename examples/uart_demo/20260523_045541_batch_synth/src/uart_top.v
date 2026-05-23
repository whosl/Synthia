// uart_top.v — Minimal UART top for demo purposes
// This file intentionally contains a missing module reference
// to demonstrate the debug agent.

module uart_top (
    input  wire       clk,
    input  wire       rst_n,
    input  wire       rx,
    output wire       tx,
    output wire [7:0] led
);

    wire [7:0] rx_data;
    wire       rx_valid;

    uart_rx #(
        .CLK_DIV(87)  // 50MHz / 115200 baud
    ) u_uart_rx (
        .clk     (clk),
        .rst_n   (rst_n),
        .rx      (rx),
        .data    (rx_data),
        .valid   (rx_valid)
    );

    // The module below is NOT defined in this file —
    // this will trigger [Synth 8-439] during synthesis.
    echo_handler u_echo (
        .clk     (clk),
        .rst_n   (rst_n),
        .data_i  (rx_data),
        .valid_i (rx_valid),
        .tx      (tx),
        .led     (led)
    );

endmodule
