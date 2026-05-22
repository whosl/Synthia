// uart_tb.v — UART Echo Testbench
// Sends a byte via UART TX, waits for it to come back on RX, checks match.

`timescale 1ns / 1ps

module uart_tb;

    reg        clk;
    reg        rst_n;

    // DUT signals
    wire       rx;   // DUT receive (driven by TB)
    wire       tx;   // DUT transmit (to TB)
    wire [3:0] led;

    // DUT instantiation
    uart_top u_dut (
        .clk   (clk),
        .rst_n (rst_n),
        .rx    (rx),
        .tx    (tx),
        .led   (led)
    );

    // Clock generator: 50 MHz, period = 20 ns
    always #10 clk = ~clk;

    // ── TB-side UART model ────────────────────────────
    localparam BIT_PERIOD = 8680;  // 115200 baud in ns (~8680.56 ns)

    reg uart_model_busy = 0;
    reg rx_drive = 1;  // idle high
    assign rx = rx_drive;

    task uart_send_byte;
        input [7:0] byte_data;
        integer i;
        begin
            uart_model_busy = 1;
            // Start bit
            rx_drive = 0;
            #(BIT_PERIOD);
            // 8 data bits, LSB first
            for (i = 0; i < 8; i = i + 1) begin
                rx_drive = byte_data[i];
                #(BIT_PERIOD);
            end
            // Stop bit
            rx_drive = 1;
            #(BIT_PERIOD);
            uart_model_busy = 0;
        end
    endtask

    task uart_recv_byte;
        output [7:0] byte_data;
        integer i;
        begin
            // Wait for start bit
            @(negedge tx);
            // Sample mid-bit
            #(BIT_PERIOD / 2);
            #(BIT_PERIOD);  // skip start bit
            for (i = 0; i < 8; i = i + 1) begin
                byte_data[i] = tx;
                #(BIT_PERIOD);
            end
            // Stop bit
            #(BIT_PERIOD);
        end
    endtask

    // ── Test sequence ─────────────────────────────────
    reg [7:0] sent_byte;
    reg [7:0] recv_byte;
    reg       test_pass;
    integer   test_count;
    integer   pass_count;
    integer   fail_count;

    initial begin
        clk    = 0;
        rst_n  = 0;
        test_count = 0;
        pass_count = 0;
        fail_count = 0;

        #100;
        rst_n  = 1;
        #200;

        $display("========================================");
        $display(" UART Echo Testbench Start");
        $display("========================================");

        // Test 1: Single byte 0x55 (alternating bits)
        sent_byte = 8'h55;
        test_count = test_count + 1;
        $display("Test %0d: Send 0x%02h ...", test_count, sent_byte);
        uart_send_byte(sent_byte);
        uart_recv_byte(recv_byte);
        if (recv_byte === sent_byte) begin
            $display("  PASS: Sent 0x%02h, Received 0x%02h", sent_byte, recv_byte);
            pass_count = pass_count + 1;
        end else begin
            $display("  FAIL: Sent 0x%02h, Received 0x%02h", sent_byte, recv_byte);
            fail_count = fail_count + 1;
        end
        #(BIT_PERIOD * 4);

        // Test 2: 0xAA (alternating bits, inverted)
        sent_byte = 8'hAA;
        test_count = test_count + 1;
        $display("Test %0d: Send 0x%02h ...", test_count, sent_byte);
        uart_send_byte(sent_byte);
        uart_recv_byte(recv_byte);
        if (recv_byte === sent_byte) begin
            $display("  PASS: Sent 0x%02h, Received 0x%02h", sent_byte, recv_byte);
            pass_count = pass_count + 1;
        end else begin
            $display("  FAIL: Sent 0x%02h, Received 0x%02h", sent_byte, recv_byte);
            fail_count = fail_count + 1;
        end
        #(BIT_PERIOD * 4);

        // Test 3: 0x00
        sent_byte = 8'h00;
        test_count = test_count + 1;
        $display("Test %0d: Send 0x%02h ...", test_count, sent_byte);
        uart_send_byte(sent_byte);
        uart_recv_byte(recv_byte);
        if (recv_byte === sent_byte) begin
            $display("  PASS: Sent 0x%02h, Received 0x%02h", sent_byte, recv_byte);
            pass_count = pass_count + 1;
        end else begin
            $display("  FAIL: Sent 0x%02h, Received 0x%02h", sent_byte, recv_byte);
            fail_count = fail_count + 1;
        end
        #(BIT_PERIOD * 4);

        // Test 4: 0xFF
        sent_byte = 8'hFF;
        test_count = test_count + 1;
        $display("Test %0d: Send 0x%02h ...", test_count, sent_byte);
        uart_send_byte(sent_byte);
        uart_recv_byte(recv_byte);
        if (recv_byte === sent_byte) begin
            $display("  PASS: Sent 0x%02h, Received 0x%02h", sent_byte, recv_byte);
            pass_count = pass_count + 1;
        end else begin
            $display("  FAIL: Sent 0x%02h, Received 0x%02h", sent_byte, recv_byte);
            fail_count = fail_count + 1;
        end
        #(BIT_PERIOD * 4);

        // Test 5: 0x3C
        sent_byte = 8'h3C;
        test_count = test_count + 1;
        $display("Test %0d: Send 0x%02h ...", test_count, sent_byte);
        uart_send_byte(sent_byte);
        uart_recv_byte(recv_byte);
        if (recv_byte === sent_byte) begin
            $display("  PASS: Sent 0x%02h, Received 0x%02h", sent_byte, recv_byte);
            pass_count = pass_count + 1;
        end else begin
            $display("  FAIL: Sent 0x%02h, Received 0x%02h", sent_byte, recv_byte);
            fail_count = fail_count + 1;
        end

        // ── Summary ──
        $display("========================================");
        $display(" Test Summary: %0d/%0d passed, %0d failed",
                 pass_count, test_count, fail_count);
        if (fail_count == 0)
            $display(" ALL TESTS PASSED");
        else
            $display(" SOME TESTS FAILED");
        $display("========================================");

        #1000;
        $finish;
    end

    // ── VCD dump ──────────────────────────────────────
    initial begin
        $dumpfile("uart_tb.vcd");
        $dumpvars(0, uart_tb);
    end

endmodule
