`timescale 1ns / 1ps
// Dedicated extended-regression entry point. The requirement-driven checks are
// shared with uart_tb; only the production board baud rate is changed.
module uart_115200_tb;
    uart_tb #(
        .BAUD_RATE(115200)
    ) regression();
endmodule
