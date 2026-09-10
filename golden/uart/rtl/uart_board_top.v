`timescale 1ns / 1ps
// VC709 board wrapper for XC7VX690T-2FFG1761C. The onboard CP2103 UART is
// configured as a 115200-bit/s byte echo after the derived clock is stable.
module uart_board_top (
    input  wire sysclk_p,
    input  wire sysclk_n,
    input  wire cpu_reset,
    input  wire uart_rxd,
    output wire uart_txd
);
    wire sysclk_200;
    wire clkfb_mmcm;
    wire clkfb_bufg;
    wire clk100_mmcm;
    wire clk100;
    wire mmcm_locked;
    wire unused_clkfboutb;
    wire unused_clkout0b;
    wire unused_clkout1;
    wire unused_clkout1b;
    wire unused_clkout2;
    wire unused_clkout2b;
    wire unused_clkout3;
    wire unused_clkout3b;
    wire unused_clkout4;
    wire unused_clkout5;
    wire unused_clkout6;
    (* ASYNC_REG = "TRUE" *) reg [1:0] reset_sync = 2'b11;
    wire [7:0] rx_data;
    wire rx_done;
    wire frame_err;
    wire tx_busy;
    wire tx_done;

    IBUFDS #(
        .DIFF_TERM("FALSE"),
        .IBUF_LOW_PWR("TRUE"),
        .IOSTANDARD("DIFF_SSTL15")
    ) u_sysclk_ibuf (.I(sysclk_p), .IB(sysclk_n), .O(sysclk_200));

    MMCME2_BASE #(
        .BANDWIDTH("OPTIMIZED"),
        .CLKIN1_PERIOD(5.000),
        .DIVCLK_DIVIDE(1),
        .CLKFBOUT_MULT_F(6.000),
        .CLKOUT0_DIVIDE_F(12.000),
        .STARTUP_WAIT("FALSE")
    ) u_clk_mmcm (
        .CLKIN1(sysclk_200), .CLKFBIN(clkfb_bufg), .RST(cpu_reset),
        .PWRDWN(1'b0), .CLKFBOUT(clkfb_mmcm), .CLKFBOUTB(unused_clkfboutb),
        .CLKOUT0(clk100_mmcm), .CLKOUT0B(unused_clkout0b),
        .CLKOUT1(unused_clkout1), .CLKOUT1B(unused_clkout1b),
        .CLKOUT2(unused_clkout2), .CLKOUT2B(unused_clkout2b),
        .CLKOUT3(unused_clkout3), .CLKOUT3B(unused_clkout3b),
        .CLKOUT4(unused_clkout4), .CLKOUT5(unused_clkout5),
        .CLKOUT6(unused_clkout6), .LOCKED(mmcm_locked)
    );

    BUFG u_clkfb_bufg (.I(clkfb_mmcm), .O(clkfb_bufg));
    BUFG u_clk100_bufg (.I(clk100_mmcm), .O(clk100));

    // cpu_reset resets the MMCM. LOCKED then provides a single, glitch-free
    // asynchronous assertion source; release is synchronized for two cycles.
    always @(posedge clk100 or negedge mmcm_locked) begin
        if (!mmcm_locked)
            reset_sync <= 2'b11;
        else
            reset_sync <= {reset_sync[0], 1'b0};
    end

    uart_top #(.CLK_FREQ(100_000_000), .BAUD_RATE(115200)) u_uart (
        .clk(clk100), .rst(reset_sync[1]),
        .tx_start(rx_done), .tx_data(rx_data), .txd(uart_txd),
        .tx_busy(tx_busy), .tx_done(tx_done),
        .rxd(uart_rxd), .rx_data(rx_data), .rx_done(rx_done),
        .frame_err(frame_err)
    );
endmodule
