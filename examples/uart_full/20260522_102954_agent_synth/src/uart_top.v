// uart_top.v — UART Echo Top Level
// Receives a byte over UART RX and immediately echoes it back over UART TX.

module uart_top (
    input  wire       clk,
    input  wire       rst_n,
    input  wire       rx,
    output wire       tx,
    output wire [3:0] led
);

    wire [7:0] rx_data;
    wire       rx_valid;

    // UART Receiver
    uart_rx #(
        .CLK_DIV(87)
    ) u_rx (
        .clk   (clk),
        .rst_n (rst_n),
        .rx    (rx),
        .data  (rx_data),
        .valid (rx_valid)
    );

    // UART Transmitter — echoes received byte
    uart_tx #(
        .CLK_DIV(434)
    ) u_tx (
        .clk   (clk),
        .rst_n (rst_n),
        .data  (rx_data),
        .send  (rx_valid),
        .tx    (tx),
        .busy  ()
    );

    // LEDs show lower 4 bits of last received byte
    reg [3:0] led_reg;
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            led_reg <= 4'd0;
        else if (rx_valid)
            led_reg <= rx_data[3:0];
    end
    assign led = led_reg;

endmodule
