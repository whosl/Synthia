`timescale 1ns / 1ps
//============================================================================
// uart_tb.sv -- UART 收发器需求驱动自检测试平台
//
// 验证边界：
//   * 使用产品默认参数 100 MHz / 9600 bit/s，不用加速参数替代正式配置；
//   * 覆盖 8N1 帧格式、忙期请求、环回、全双工、异常输入、容差、复位和吞吐；
//   * 每项检查失败均以 $fatal 终止，全部通过才打印最终 PASS；
//   * 这是行为级候选证据，不替代门级仿真、板级测试或人工批准。
//============================================================================
module uart_tb;

    localparam integer CLK_FREQ       = 100_000_000;
    localparam integer BAUD_RATE      = 9600;
    localparam integer CLKS_PER_BIT   = CLK_FREQ / BAUD_RATE; // 10416
    localparam integer CLK_PERIOD_NS  = 10;
    localparam integer DUT_BIT_NS     = CLKS_PER_BIT * CLK_PERIOD_NS;
    localparam integer EXT_FAST_NS    = 102_083; // 9600 bit/s 的 +2% 端点
    localparam integer EXT_SLOW_NS    = 106_250; // 9600 bit/s 的 -2% 端点
    localparam integer MAX_INTERVAL_NS = 1_000_000_000 / 960; // >= 960 byte/s

    reg        clk         = 1'b0;
    reg        rst         = 1'b1;
    reg        tx_start    = 1'b0;
    reg  [7:0] tx_data     = 8'h00;
    reg        loopback_en = 1'b0;
    reg        ext_rxd     = 1'b1;
    wire       rxd         = loopback_en ? txd : ext_rxd;
    wire       txd;
    wire       tx_busy;
    wire       tx_done;
    wire [7:0] rx_data;
    wire       rx_done;
    wire       frame_err;

    integer tx_done_count = 0;
    integer rx_done_count = 0;
    integer frame_err_count = 0;
    reg previous_tx_done = 1'b0;
    reg previous_rx_done = 1'b0;
    reg previous_frame_err = 1'b0;

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
        .rxd       (rxd),
        .rx_data   (rx_data),
        .rx_done   (rx_done),
        .frame_err (frame_err)
    );

    always #(CLK_PERIOD_NS / 2) clk = ~clk;

    // 全局脉冲契约：done/error 均只能维持一拍；错误帧不得同时宣告有效字节。
    always @(posedge clk) begin
        if (!rst) begin
            if (tx_done && previous_tx_done)
                $fatal(1, "TX_DONE_PULSE_WIDTH: tx_done exceeded one clock");
            if (rx_done && previous_rx_done)
                $fatal(1, "RX_DONE_PULSE_WIDTH: rx_done exceeded one clock");
            if (frame_err && previous_frame_err)
                $fatal(1, "FRAME_ERR_PULSE_WIDTH: frame_err exceeded one clock");
            if (frame_err && rx_done)
                $fatal(1, "FRAME_ERR_VALID_CONFLICT: frame_err and rx_done asserted together");
            if (tx_done)
                tx_done_count = tx_done_count + 1;
            if (rx_done)
                rx_done_count = rx_done_count + 1;
            if (frame_err)
                frame_err_count = frame_err_count + 1;
        end
        previous_tx_done <= tx_done;
        previous_rx_done <= rx_done;
        previous_frame_err <= frame_err;
    end

    task automatic check(input bit condition, input string message);
        begin
            if (!condition)
                $fatal(1, "%s", message);
        end
    endtask

    task automatic apply_reset;
        begin
            @(negedge clk);
            rst      = 1'b1;
            tx_start = 1'b0;
            ext_rxd  = 1'b1;
            repeat (3) @(posedge clk);
            #1;
            check(txd === 1'b1, "RESET_TXD: txd must be idle high");
            check(tx_busy === 1'b0, "RESET_BUSY: tx_busy must be low");
            check(tx_done === 1'b0, "RESET_TX_DONE: tx_done must be low");
            check(rx_data === 8'h00, "RESET_RX_DATA: rx_data must be zero");
            check(rx_done === 1'b0, "RESET_RX_DONE: rx_done must be low");
            check(frame_err === 1'b0, "RESET_FRAME_ERR: frame_err must be low");
            @(negedge clk);
            rst = 1'b0;
            repeat (3) @(posedge clk);
        end
    endtask

    task automatic start_tx(input [7:0] data);
        begin
            check(tx_busy === 1'b0, "TX_START_PRECONDITION: transmitter was busy");
            @(negedge clk);
            tx_data  = data;
            tx_start = 1'b1;
            @(negedge clk);
            tx_start = 1'b0;
            check(tx_busy === 1'b1, "TX_START_ACCEPT: tx_busy did not assert");
        end
    endtask

    task automatic pulse_tx_while_busy(input [7:0] data);
        begin
            check(tx_busy === 1'b1, "TX_BUSY_PRECONDITION: transmitter was not busy");
            @(negedge clk);
            tx_data  = data;
            tx_start = 1'b1;
            @(negedge clk);
            tx_start = 1'b0;
        end
    endtask

    task automatic check_tx_frame(input [7:0] expected);
        integer i;
        begin
            @(negedge txd);
            #(DUT_BIT_NS / 2);
            check(txd === 1'b0, "TX_START_BIT: start bit was not low at midpoint");
            check(tx_busy === 1'b1, "TX_BUSY_FRAME: tx_busy dropped inside frame");
            for (i = 0; i < 8; i = i + 1) begin
                #(DUT_BIT_NS);
                if (txd !== expected[i])
                    $fatal(1, "TX_DATA_BIT_%0d: expected %0b got %0b", i,
                           expected[i], txd);
                check(tx_busy === 1'b1, "TX_BUSY_DATA: tx_busy dropped in data field");
            end
            #(DUT_BIT_NS);
            check(txd === 1'b1, "TX_STOP_BIT: stop bit was not high at midpoint");
            check(tx_busy === 1'b1, "TX_BUSY_STOP: tx_busy dropped before stop completed");
        end
    endtask

    task automatic drive_external_frame(
        input [7:0] data,
        input integer bit_period_ns,
        input bit stop_level
    );
        integer i;
        begin
            ext_rxd = 1'b0;
            #(bit_period_ns);
            for (i = 0; i < 8; i = i + 1) begin
                ext_rxd = data[i];
                #(bit_period_ns);
            end
            ext_rxd = stop_level;
            #(bit_period_ns);
            ext_rxd = 1'b1;
        end
    endtask

    task automatic drive_and_expect_rx(
        input [7:0] data,
        input integer bit_period_ns,
        input bit stop_level,
        input bit expected_error,
        input string label_text
    );
        integer before_rx;
        integer before_err;
        reg [7:0] before_data;
        begin
            before_rx = rx_done_count;
            before_err = frame_err_count;
            before_data = rx_data;
            @(negedge clk);
            fork
                drive_external_frame(data, bit_period_ns, stop_level);
                begin
                    if (expected_error) begin
                        @(posedge frame_err);
                        #1;
                        check(rx_done === 1'b0, {label_text, "_RX_DONE_SUPPRESSED"});
                        check(rx_data === before_data, {label_text, "_RX_DATA_HELD"});
                    end else begin
                        @(posedge rx_done);
                        #1;
                        if (rx_data !== data)
                            $fatal(1, "%s_DATA: expected 0x%02h got 0x%02h",
                                   label_text, data, rx_data);
                        check(frame_err === 1'b0, {label_text, "_FRAME_ERR"});
                    end
                end
            join
            @(posedge clk);
            #1;
            check(rx_done === 1'b0, {label_text, "_RX_DONE_WIDTH"});
            check(frame_err === 1'b0, {label_text, "_FRAME_ERR_WIDTH"});
            check(rx_done_count == before_rx + (expected_error ? 0 : 1),
                  {label_text, "_RX_COUNT"});
            check(frame_err_count == before_err + expected_error,
                  {label_text, "_ERROR_COUNT"});
        end
    endtask

    task automatic loopback_and_expect(input [7:0] data, input string label_text);
        integer before_rx;
        begin
            loopback_en = 1'b1;
            before_rx = rx_done_count;
            start_tx(data);
            @(posedge rx_done);
            #1;
            if ((rx_data !== data) || (frame_err !== 1'b0))
                $fatal(1, "%s: sent 0x%02h got 0x%02h frame_err=%0b",
                       label_text, data, rx_data, frame_err);
            @(posedge tx_done);
            @(posedge clk);
            #1;
            check(rx_done_count == before_rx + 1, {label_text, "_RX_COUNT"});
        end
    endtask

    task automatic test_tx_format_and_busy_reject;
        integer before_done;
        begin
            $display("CASE 01: TX 8N1 format and busy-request rejection");
            loopback_en = 1'b0;
            ext_rxd = 1'b1;
            before_done = tx_done_count;
            start_tx(8'h55);
            fork
                check_tx_frame(8'h55);
                begin
                    #(DUT_BIT_NS * 2);
                    pulse_tx_while_busy(8'hAA);
                end
            join
            @(posedge tx_done);
            repeat (3) @(posedge clk);
            #1;
            check(tx_busy === 1'b0, "TX_BUSY_RELEASE: tx_busy remained high");
            check(txd === 1'b1, "TX_IDLE_LEVEL: txd did not return high");
            check(tx_done_count == before_done + 1,
                  "TX_BUSY_REJECT: busy request created an extra frame");
        end
    endtask

    task automatic test_loopback_patterns;
        begin
            $display("CASE 02: nominal loopback boundary and transition patterns");
            loopback_and_expect(8'hA5, "LOOPBACK_A5");
            loopback_and_expect(8'h00, "LOOPBACK_00");
            loopback_and_expect(8'hFF, "LOOPBACK_FF");
            loopback_and_expect(8'h3C, "LOOPBACK_3C");
        end
    endtask

    task automatic test_full_duplex;
        integer before_rx;
        begin
            $display("CASE 03: independent simultaneous TX and RX (full duplex)");
            loopback_en = 1'b0;
            ext_rxd = 1'b1;
            before_rx = rx_done_count;
            start_tx(8'hC3);
            fork
                check_tx_frame(8'hC3);
                begin
                    drive_external_frame(8'h5A, DUT_BIT_NS, 1'b1);
                end
                begin
                    @(posedge rx_done);
                    #1;
                    check(rx_data === 8'h5A, "FULL_DUPLEX_RX_DATA");
                    check(frame_err === 1'b0, "FULL_DUPLEX_FRAME_ERR");
                end
            join
            if (tx_busy)
                @(posedge tx_done);
            @(posedge clk);
            #1;
            check(rx_done_count == before_rx + 1, "FULL_DUPLEX_RX_COUNT");
        end
    endtask

    task automatic test_false_start;
        integer before_rx;
        integer before_err;
        begin
            $display("CASE 04: false-start glitch rejection");
            loopback_en = 1'b0;
            ext_rxd = 1'b1;
            before_rx = rx_done_count;
            before_err = frame_err_count;
            @(negedge clk);
            ext_rxd = 1'b0;
            #(DUT_BIT_NS / 4);
            ext_rxd = 1'b1;
            #(DUT_BIT_NS);
            check(rx_done_count == before_rx, "FALSE_START_RX_DONE");
            check(frame_err_count == before_err, "FALSE_START_FRAME_ERR");
        end
    endtask

    task automatic test_frame_error_and_recovery;
        begin
            $display("CASE 05: bad stop bit indication and subsequent recovery");
            loopback_en = 1'b0;
            drive_and_expect_rx(8'h96, DUT_BIT_NS, 1'b0, 1'b1, "BAD_STOP");
            #(DUT_BIT_NS);
            drive_and_expect_rx(8'h69, DUT_BIT_NS, 1'b1, 1'b0, "ERROR_RECOVERY");
        end
    endtask

    task automatic test_baud_tolerance;
        begin
            $display("CASE 06: external baud-rate tolerance at +2%% and -2%%");
            loopback_en = 1'b0;
            drive_and_expect_rx(8'h87, EXT_FAST_NS, 1'b1, 1'b0, "BAUD_PLUS_2_PERCENT");
            #(DUT_BIT_NS);
            drive_and_expect_rx(8'h78, EXT_SLOW_NS, 1'b1, 1'b0, "BAUD_MINUS_2_PERCENT");
        end
    endtask

    task automatic test_back_to_back_rx;
        reg [7:0] first_data;
        reg [7:0] second_data;
        integer received;
        begin
            $display("CASE 07: two RX frames with exactly one stop bit between starts");
            loopback_en = 1'b0;
            ext_rxd = 1'b1;
            received = 0;
            fork
                begin
                    @(negedge clk);
                    drive_external_frame(8'h12, DUT_BIT_NS, 1'b1);
                    drive_external_frame(8'hE7, DUT_BIT_NS, 1'b1);
                end
                begin
                    @(posedge rx_done);
                    #1;
                    first_data = rx_data;
                    check(frame_err === 1'b0, "BACK_TO_BACK_FIRST_ERROR");
                    received = received + 1;
                    @(posedge rx_done);
                    #1;
                    second_data = rx_data;
                    check(frame_err === 1'b0, "BACK_TO_BACK_SECOND_ERROR");
                    received = received + 1;
                end
            join
            check(received == 2, "BACK_TO_BACK_RX_COUNT");
            check(first_data === 8'h12, "BACK_TO_BACK_FIRST_DATA");
            check(second_data === 8'hE7, "BACK_TO_BACK_SECOND_DATA");
        end
    endtask

    task automatic test_reset_interrupt;
        integer before_done;
        begin
            $display("CASE 08: synchronous reset interrupts an active frame safely");
            loopback_en = 1'b0;
            ext_rxd = 1'b1;
            before_done = tx_done_count;
            start_tx(8'h00);
            @(negedge txd);
            #(DUT_BIT_NS * 2 + DUT_BIT_NS / 2);
            @(negedge clk);
            rst = 1'b1;
            repeat (2) @(posedge clk);
            #1;
            check(txd === 1'b1, "RESET_INTERRUPT_TXD");
            check(tx_busy === 1'b0, "RESET_INTERRUPT_BUSY");
            check(tx_done === 1'b0, "RESET_INTERRUPT_DONE");
            check(rx_done === 1'b0, "RESET_INTERRUPT_RX_DONE");
            check(frame_err === 1'b0, "RESET_INTERRUPT_FRAME_ERR");
            check(tx_done_count == before_done, "RESET_INTERRUPT_FALSE_COMPLETION");
            @(negedge clk);
            rst = 1'b0;
            repeat (3) @(posedge clk);
            loopback_and_expect(8'hD2, "RESET_RECOVERY");
        end
    endtask

    task automatic test_tx_throughput;
        time first_start;
        time second_start;
        time interval_ns;
        begin
            $display("CASE 09: minimum sustained TX start-to-start throughput");
            loopback_en = 1'b0;
            ext_rxd = 1'b1;
            start_tx(8'hFF);
            @(negedge txd);
            first_start = $time;
            @(posedge tx_done);
            start_tx(8'hFF);
            @(negedge txd);
            second_start = $time;
            interval_ns = second_start - first_start;
            if (interval_ns > MAX_INTERVAL_NS)
                $fatal(1, "TX_THROUGHPUT: interval %0d ns exceeds %0d ns",
                       interval_ns, MAX_INTERVAL_NS);
            $display("  observed start interval=%0d ns, throughput >= 960 byte/s", interval_ns);
            @(posedge tx_done);
        end
    endtask

    task automatic test_illegal_state_recovery;
        begin
            $display("CASE 10: reserved-state injection and deterministic recovery");
            loopback_en = 1'b0;
            ext_rxd = 1'b1;
            check(tx_busy === 1'b0, "ILLEGAL_STATE_TX_PRECONDITION");
            @(negedge clk);
            // TB-only hierarchical fault injection. Three-bit FSM encoding keeps
            // 3'b100..3'b111 reserved, so default recovery is dynamically testable.
            dut.u_uart_tx.state = 3'b111;
            dut.u_uart_tx.tx_busy = 1'b1;
            dut.u_uart_tx.txd = 1'b0;
            dut.u_uart_rx.state = 3'b111;
            @(posedge clk);
            #1;
            check(dut.u_uart_tx.state === 3'd0, "ILLEGAL_STATE_TX_STATE");
            check(tx_busy === 1'b0, "ILLEGAL_STATE_TX_BUSY");
            check(txd === 1'b1, "ILLEGAL_STATE_TXD");
            check(dut.u_uart_rx.state === 3'd0, "ILLEGAL_STATE_RX_STATE");
            check(rx_done === 1'b0, "ILLEGAL_STATE_RX_DONE");
            check(frame_err === 1'b0, "ILLEGAL_STATE_FRAME_ERR");
            $display("  reserved states recovered; starting functional recovery frame");
            loopback_and_expect(8'h4B, "ILLEGAL_STATE_RECOVERY");
            $display("  functional recovery frame complete");
        end
    endtask

    initial begin
        $display("UART candidate verification: CLK=%0d Hz BAUD=%0d CLKS_PER_BIT=%0d",
                 CLK_FREQ, BAUD_RATE, CLKS_PER_BIT);
        apply_reset();
        test_tx_format_and_busy_reject();
        test_loopback_patterns();
        test_full_duplex();
        test_false_start();
        test_frame_error_and_recovery();
        test_baud_tolerance();
        test_back_to_back_rx();
        test_reset_interrupt();
        test_tx_throughput();
        test_illegal_state_recovery();

        repeat (3) @(posedge clk);
        $display("PASS: 10 UART requirement cases passed; tx_done=%0d rx_done=%0d frame_err=%0d",
                 tx_done_count, rx_done_count, frame_err_count);
        $finish;
    end

    initial begin
        #(DUT_BIT_NS * 220);
        $fatal(1, "WATCHDOG: simulation did not complete");
    end

endmodule
