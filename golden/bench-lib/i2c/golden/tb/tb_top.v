// tb_top — golden self-checking testbench for the I2C master (bench-lib T2, p17)
//
// Covers I2C-DOC-001 TST-002 scenarios (a)-(l):
//   (a)  reset defaults + idle open-drain release
//   (b)  standard write transaction (START+addr+W+2 data+STOP), slave captures, RXACK=0
//   (c)  read transaction (addr+R, 2 bytes, NACK on last, STOP), data vs model preload
//   (d)  combined transaction: pointer write then repeated-START read-back
//   (e)  slave NACK injection -> RXACK=1, later transaction unpolluted
//   (f)  SCL frequency measurement at PRER=199 (100 kHz) and PRER=49 (400 kHz), +/-10%
//   (g)  slave clock-stretch injection -> transfer completes; injector SCL hold
//        (multi-master clock-sync proxy) -> transfer completes
//   (h)  arbitration-loss injection (external driver holds SDA low while master sends 1)
//        -> AL set, master releases bus, retry succeeds (STA clears AL)
//   (i)  BUSY semantics: 1 after START, 0 after STOP
//   (j)  interrupt chain: IEN gate, irq follows IF, IACK clears
//   (k)  glitch injection on SDA and SCL during SCL high -> filtered, transfer intact
//   (l)  back-to-back transactions
//
// Expectations come from the behavioral slave model (independent of the DUT).
// Any failed check $fatal's with the scenario id; all-pass prints PASS.
// Verilog-2001 only (no SystemVerilog fork variants).
`timescale 1ns / 1ps

// --------------------------------------------------------------------
// behavioral I2C slave (EEPROM-like: write = [ptr, d0, d1...], read = mem[ptr++])
// - glitch-filtered bus views: majority of 3 samples every 150 ns
//   (rejects 100 ns spikes; passes real edges of both 100k/400k modes)
// - TB-configurable: mem preload, force_nack, stretch_pending/stretch_ns
// - single negedge block + single posedge block: no same-edge ordering races
// --------------------------------------------------------------------
module i2c_slave_behav #(parameter [6:0] I2C_ADR = 7'h50)(scl, sda);
  input wire scl;
  inout wire sda;

  reg m0 = 1, m1 = 1, m2 = 1;        // scl majority chain
  reg n0 = 1, n1 = 1, n2 = 1;        // sda majority chain
  always #150 begin m2 = m1; m1 = m0; m0 = scl; end
  always #150 begin n2 = n1; n1 = n0; n0 = sda; end
  wire f_scl = (m0 & m1) | (m1 & m2) | (m0 & m2);
  wire f_sda = (n0 & n1) | (n1 & n2) | (n0 & n2);

  // config / observation (TB sets these hierarchically)
  reg [7:0] mem [0:15];
  reg [7:0] captured [0:15];
  integer   cap_cnt = 0;
  reg       force_nack = 0;
  reg       stretch_pending = 0;
  integer   stretch_ns = 2500;

  // drivers (open-drain: pull low only)
  reg sda_drv = 1;
  reg scl_drv = 1;
  assign sda = sda_drv ? 1'bz : 1'b0;
  assign scl = scl_drv ? 1'bz : 1'b0;

  localparam S_IDLE = 0, S_ADDR = 1, S_PTR = 2, S_PTR_ACK = 3,
             S_WR = 4, S_WR_ACK = 5, S_RD = 6;
  reg [2:0] st = S_IDLE;
  reg [7:0] sr = 0;
  reg [2:0] bcnt = 0;
  reg       rw = 0;
  reg [3:0] ptr = 0;
  reg [7:0] tx_byte = 0;

  // start / stop detection (filtered, while SCL high)
  always @(negedge f_sda) if (f_scl === 1'b1) begin
    st = S_ADDR; bcnt = 3'd7; sr = 8'h00; sda_drv = 1;
  end
  always @(posedge f_sda) if (f_scl === 1'b1) begin
    st = S_IDLE; sda_drv = 1;
  end

  // sample side
  always @(posedge f_scl) begin
    if (st == S_ADDR || st == S_PTR || st == S_WR)
      sr <= #1 {sr[6:0], f_sda};
    bcnt <= #1 bcnt - 3'd1;
    if (st == S_RD && bcnt == 3'd0) begin
      if (f_sda === 1'b1) st <= #1 S_IDLE;          // master NACK: read done
      else begin tx_byte <= #1 mem[ptr]; ptr <= #1 ptr + 4'd1; end
    end
  end

  // drive side (single writer for sda_drv)
  always @(negedge f_scl) begin
    sda_drv = 1;                                     // default: release
    if (stretch_pending && (st == S_ADDR || st == S_PTR || st == S_WR || st == S_RD)) begin
      stretch_pending = 0;
      scl_drv = 0;                                   // hold SCL low (stretch)
      #(stretch_ns);
      scl_drv = 1;
    end
    case (st)
      S_ADDR: if (bcnt == 3'd0) begin
        if (sr[7:1] === I2C_ADR) begin
          sda_drv = 0;                               // ACK our address (9th bit)
          rw = sr[0];
          if (rw) begin tx_byte = mem[ptr]; st = S_RD; end
          else st = S_PTR;
          bcnt = 3'd7;
        end else st = S_IDLE;
      end
      S_PTR: if (bcnt == 3'd0) begin
        sda_drv = force_nack ? 1'b1 : 1'b0;          // ACK pointer byte
        force_nack = 0;
        ptr = sr[3:0];
        st = S_PTR_ACK; bcnt = 3'd7;
      end
      S_PTR_ACK: begin st = S_WR; end
      S_WR: if (bcnt == 3'd0) begin
        sda_drv = force_nack ? 1'b1 : 1'b0;          // ACK / injected NACK
        force_nack = 0;
        captured[cap_cnt] = sr;
        mem[ptr] = sr;
        cap_cnt = cap_cnt + 1;
        ptr = ptr + 4'd1;
        st = S_WR_ACK; bcnt = 3'd7;
      end
      S_WR_ACK: begin st = S_WR; end
      S_RD: begin
        if (bcnt != 3'd0) begin
          sda_drv = tx_byte[7];                      // present MSB-first
          tx_byte = {tx_byte[6:0], 1'b1};
        end
        // bcnt==0: keep released for the master ACK/NACK bit
      end
      default: ;
    endcase
  end

endmodule

// --------------------------------------------------------------------
// testbench top
// --------------------------------------------------------------------
module tb_top;

  reg clk = 0;
  always #5 clk = ~clk;                              // 100 MHz

  reg rst = 1;
  initial begin
    repeat (4) @(negedge clk);
    rst = 0;
    repeat (4) @(negedge clk);
  end

  tri1 scl, sda;                                     // open-drain bus + pull-up

  reg inj_sda = 0, inj_scl = 0;                      // injector (pull low only)
  assign sda = inj_sda ? 1'b0 : 1'bz;
  assign scl = inj_scl ? 1'b0 : 1'bz;

  reg        psel = 0, penable = 0, pwrite = 0;
  reg  [2:0] paddr = 0;
  reg  [7:0] pwdata = 0;
  wire [7:0] prdata;
  wire       pready, irq;

  i2c_top dut (
    .clk(clk), .rst(rst),
    .psel(psel), .penable(penable), .pwrite(pwrite),
    .paddr(paddr), .pwdata(pwdata), .prdata(prdata), .pready(pready),
    .scl(scl), .sda(sda), .irq(irq)
  );

  i2c_slave_behav #(.I2C_ADR(7'h50)) u_slave (.scl(scl), .sda(sda));

  // ---------------- register access ----------------
  task reg_write(input [2:0] a, input [7:0] d);
    begin
      @(negedge clk);
      psel = 1; penable = 1; pwrite = 1; paddr = a; pwdata = d;
      @(negedge clk);
      psel = 0; penable = 0; pwrite = 0;
      repeat (2) @(negedge clk);
    end
  endtask

  task reg_read(input [2:0] a, output [7:0] d);
    begin
      @(negedge clk);
      psel = 1; penable = 1; pwrite = 0; paddr = a;
      @(negedge clk);
      d = prdata;
      psel = 0; penable = 0;
      @(negedge clk);
    end
  endtask

  localparam [2:0] A_PRER = 3'd0, A_PRER_HI = 3'd1, A_CTR = 3'd2,
                   A_TXR  = 3'd3, A_CR     = 3'd4;
  localparam [7:0] B_STA = 8'h80, B_STO = 8'h40, B_RD  = 8'h20,
                   B_WR  = 8'h10, B_ACK = 8'h08, B_IACK = 8'h01;
  localparam [7:0] SR_RXACK = 8'h80, SR_BUSY = 8'h40, SR_AL = 8'h20, SR_TIP = 8'h02;

  task wait_if(input integer max_us, input integer scid);
    integer t; reg [7:0] sr;
    begin
      sr = 8'h00;
      for (t = 0; t <= max_us; t = t + 1) begin
        #1000;
        reg_read(A_CR, sr);
        if (sr[0] === 1'b1) t = max_us + 1;
      end
      if (!(sr[0] === 1'b1))
        $fatal(1, "scenario %0d: IF never set within %0d us (sr=%02h)", scid, max_us, sr);
    end
  endtask

  // issue CR command, wait IF, clear IF
  task cr_cmd(input [7:0] cmd, input integer max_us, input integer scid);
    begin
      reg_write(A_CR, cmd);
      wait_if(max_us, scid);
      reg_write(A_CR, B_IACK);
    end
  endtask

  task read_sr(output [7:0] sr);
    begin reg_read(A_CR, sr); end
  endtask

  // ---------------- checks ----------------
  integer pass_cnt = 0;
  task check(input integer scid, input cond);
    begin
      if (cond !== 1'b1)
        $fatal(1, "scenario %0d: check FAILED (cond=%b)", scid, cond);
      pass_cnt = pass_cnt + 1;
    end
  endtask

  // filtered scl view for measurements (same majority scheme as the slave model)
  reg p0 = 1, p1 = 1, p2 = 1;
  always #150 begin p2 = p1; p1 = p0; p0 = scl; end
  wire mf_scl = (p0 & p1) | (p1 & p2) | (p0 & p2);

  task measure_scl_period(output integer period_ns);
    begin
      @(negedge mf_scl);                             // skip: post-command edge
      @(negedge mf_scl);
      period_ns = $time;
      @(negedge mf_scl);
      period_ns = $time - period_ns;
    end
  endtask

  // ---------------- main ----------------
  reg [7:0] sr, d;
  integer   period;

  initial begin : main
    #200;

    // ---- (a) reset defaults + idle release ----
    read_sr(sr);            check(1, sr == 8'h00);
    reg_read(A_PRER, d);    check(1, d == 8'hFF);
    reg_read(A_PRER_HI, d); check(1, d == 8'hFF);
    reg_read(A_CTR, d);     check(1, d == 8'h00);
    reg_read(3'd5, d);      check(1, d == 8'h00);    // undefined addr reads 0
    check(1, scl === 1'b1 && sda === 1'b1);          // open-drain released
    check(1, pready === 1'b1);

    // enable core, 400 kHz
    reg_write(A_PRER, 8'd49);
    reg_write(A_PRER_HI, 8'd0);
    reg_write(A_CTR, 8'hC0);                          // EN | IEN
    #1000;

    // ---- (i) BUSY semantics (warm-up write) ----
    read_sr(sr); check(9, (sr & SR_BUSY) == 8'h00);
    reg_write(A_TXR, 8'hA0);                          // 0x50<<1 | W
    reg_write(A_CR, B_STA | B_WR);                    // fire, observe mid-flight
    #3000;
    read_sr(sr); check(9, (sr & SR_BUSY) != 8'h00);
    wait_if(60, 9); reg_write(A_CR, B_IACK);
    reg_write(A_TXR, 8'h55);
    cr_cmd(B_WR, 60, 9);
    cr_cmd(B_STO, 60, 9);
    period = 0;                                       // reuse as poll counter
    while (((sr & SR_BUSY) != 8'h00) && period < 60) begin
      #1000; read_sr(sr); period = period + 1;
    end
    check(9, (sr & SR_BUSY) == 8'h00);
    check(9, u_slave.cap_cnt == 1 && u_slave.captured[0] == 8'h55);

    // ---- (l) back-to-back transactions ----
    u_slave.cap_cnt = 0;
    reg_write(A_TXR, 8'hA0);
    cr_cmd(B_STA | B_WR, 60, 12);
    reg_write(A_TXR, 8'h00);                          // pointer 0
    cr_cmd(B_WR, 60, 12);
    reg_write(A_TXR, 8'hDE);
    cr_cmd(B_WR, 60, 12);
    reg_write(A_TXR, 8'hAD);
    cr_cmd(B_WR, 60, 12);
    cr_cmd(B_STO, 60, 12);
    check(12, u_slave.cap_cnt == 2);
    check(12, u_slave.captured[0] == 8'hDE && u_slave.captured[1] == 8'hAD);

    // ---- (b) standard write transaction, RXACK=0 ----
    u_slave.cap_cnt = 0;
    reg_write(A_TXR, 8'hA0);
    cr_cmd(B_STA | B_WR, 60, 2);
    read_sr(sr); check(2, (sr & SR_RXACK) == 8'h00);
    reg_write(A_TXR, 8'h01);                          // pointer 1
    cr_cmd(B_WR, 60, 2);
    read_sr(sr); check(2, (sr & SR_RXACK) == 8'h00);
    reg_write(A_TXR, 8'h77);
    cr_cmd(B_WR, 60, 2);
    read_sr(sr); check(2, (sr & SR_RXACK) == 8'h00);
    reg_write(A_TXR, 8'h88);
    cr_cmd(B_WR, 60, 2);
    read_sr(sr); check(2, (sr & SR_RXACK) == 8'h00);
    cr_cmd(B_STO, 60, 2);
    check(2, u_slave.cap_cnt == 2);
    check(2, u_slave.captured[0] == 8'h77 && u_slave.captured[1] == 8'h88);
    check(2, u_slave.mem[1] == 8'h77 && u_slave.mem[2] == 8'h88);

    // ---- (d) combined: pointer write + repeated-START read-back ----
    u_slave.cap_cnt = 0;
    reg_write(A_TXR, 8'hA0);
    cr_cmd(B_STA | B_WR, 60, 4);
    reg_write(A_TXR, 8'h01);                          // pointer -> 1
    cr_cmd(B_WR, 60, 4);
    reg_write(A_TXR, 8'hA1);                          // 0x50<<1 | R
    cr_cmd(B_STA | B_RD, 60, 4);                      // repeated START
    reg_read(A_TXR, d);
    check(4, d == 8'h77);
    cr_cmd(B_RD, 60, 4);
    reg_read(A_TXR, d);
    check(4, d == 8'h88);
    cr_cmd(B_RD | B_ACK, 60, 4);                      // last byte NACK
    cr_cmd(B_STO, 60, 4);
    check(4, u_slave.cap_cnt == 0);

    // ---- (c) plain read from preload ----
    u_slave.mem[0] = 8'h5A; u_slave.mem[1] = 8'hC3;
    u_slave.ptr = 0;
    reg_write(A_TXR, 8'hA1);
    cr_cmd(B_STA | B_RD, 60, 3);
    reg_read(A_TXR, d);
    check(3, d == 8'h5A);
    cr_cmd(B_RD | B_ACK, 60, 3);
    reg_read(A_TXR, d);
    check(3, d == 8'hC3);
    cr_cmd(B_STO, 60, 3);

    // ---- (e) slave NACK injection ----
    u_slave.force_nack = 1;
    reg_write(A_TXR, 8'hA0);
    cr_cmd(B_STA | B_WR, 60, 5);
    read_sr(sr); check(5, (sr & SR_RXACK) != 8'h00);
    cr_cmd(B_STO, 60, 5);
    u_slave.cap_cnt = 0;                              // next transaction must be clean
    reg_write(A_TXR, 8'hA0);
    cr_cmd(B_STA | B_WR, 60, 5);
    read_sr(sr); check(5, (sr & SR_RXACK) == 8'h00);
    reg_write(A_TXR, 8'h00);
    cr_cmd(B_WR, 60, 5);
    cr_cmd(B_STO, 60, 5);
    check(5, u_slave.cap_cnt == 1 && u_slave.captured[0] == 8'h00);

    // ---- (f) SCL frequency: 400 kHz then 100 kHz ----
    reg_write(A_TXR, 8'hA0);
    cr_cmd(B_STA | B_WR, 60, 6);
    reg_write(A_TXR, 8'h11);
    fork
      begin : f_wr400
        cr_cmd(B_WR, 60, 6);
      end
      begin : f_meas400
        measure_scl_period(period);
      end
    join
    check(6, period > 2250 && period < 2750);         // 2500 ns +/-10%
    cr_cmd(B_STO, 60, 6);

    reg_write(A_PRER, 8'd199);                        // 100 kHz
    #1000;
    reg_write(A_TXR, 8'hA0);
    cr_cmd(B_STA | B_WR, 240, 6);
    reg_write(A_TXR, 8'h22);
    fork
      begin : f_wr100
        cr_cmd(B_WR, 240, 6);
      end
      begin : f_meas100
        measure_scl_period(period);
      end
    join
    check(6, period > 9000 && period < 11000);        // 10000 ns +/-10%
    cr_cmd(B_STO, 240, 6);
    reg_write(A_PRER, 8'd49);                         // back to 400 kHz
    #1000;

    // ---- (g) clock stretch + injector SCL hold (sync proxy) ----
    u_slave.cap_cnt = 0;
    u_slave.stretch_pending = 1;
    u_slave.stretch_ns = 2500;
    reg_write(A_TXR, 8'hA0);
    cr_cmd(B_STA | B_WR, 90, 7);
    reg_write(A_TXR, 8'h33);
    fork
      begin : g_wr
        cr_cmd(B_WR, 90, 7);
      end
      begin : g_hold                                 // hold SCL low past master release
        @(negedge mf_scl); #400;
        inj_scl = 1; #600;
        inj_scl = 0;
      end
    join
    cr_cmd(B_STO, 90, 7);
    check(7, u_slave.cap_cnt == 1 && u_slave.captured[0] == 8'h33);

    // ---- (k) glitch immunity (100 ns pulses on SDA and SCL during SCL high) ----
    u_slave.cap_cnt = 0;
    reg_write(A_TXR, 8'hA0);
    cr_cmd(B_STA | B_WR, 60, 11);
    reg_write(A_TXR, 8'hAA);
    fork
      begin : k_wr
        cr_cmd(B_WR, 60, 11);
      end
      begin : k_sda_glitch
        @(posedge mf_scl); #500;
        inj_sda = 1; #100;
        inj_sda = 0;
      end
      begin : k_scl_glitch
        @(posedge mf_scl); #700;
        inj_scl = 1; #100;
        inj_scl = 0;
      end
    join
    cr_cmd(B_STO, 60, 11);
    check(11, u_slave.cap_cnt == 1 && u_slave.captured[0] == 8'hAA);
    read_sr(sr); check(11, (sr & SR_BUSY) == 8'h00);

    // ---- (h) arbitration loss ----
    u_slave.cap_cnt = 0;
    reg_write(A_TXR, 8'hA0);                          // bit7=1 -> we lose to a low driver
    fork
      begin : h_cmd                                  // manual flow: keep IF for irq check
        reg_write(A_CR, B_STA | B_WR);
        wait_if(90, 8);                               // returns on AL (IF set by AL)
      end
      begin : h_inject
        @(negedge mf_scl); #300;                      // master drives addr bit7 = 1 (released)
        inj_sda = 1;                                  // "other master" drives 0
        #25000;                                       // hold across the aborted byte
        inj_sda = 0;                                  // release -> trailing STOP (bus cleanup)
      end
    join
    #20000;                                           // settle
    read_sr(sr); check(8, (sr & SR_AL) != 8'h00);     // AL set
    check(8, irq === 1'b1);                           // IF set by AL, IEN=1
    check(8, scl === 1'b1 && sda === 1'b1);           // master released the bus
    check(8, (sr & SR_BUSY) == 8'h00);                // trailing STOP cleared BUSY
    check(8, u_slave.cap_cnt == 0);                   // nothing delivered
    reg_write(A_CR, B_IACK);
    // retry: STA clears AL
    reg_write(A_TXR, 8'hA0);
    cr_cmd(B_STA | B_WR, 90, 8);
    read_sr(sr); check(8, (sr & SR_AL) == 8'h00);
    reg_write(A_TXR, 8'h66);
    cr_cmd(B_WR, 90, 8);
    read_sr(sr); check(8, (sr & SR_RXACK) == 8'h00);
    cr_cmd(B_STO, 90, 8);
    check(8, u_slave.cap_cnt == 1 && u_slave.captured[0] == 8'h66);

    // ---- (j) interrupt chain (manual flow, no auto-IACK) ----
    reg_write(A_CTR, 8'h80);                          // EN, IEN=0
    #1000;
    reg_write(A_TXR, 8'hA0);
    reg_write(A_CR, B_STA | B_WR);
    wait_if(60, 10);
    read_sr(sr); check(10, sr[0] === 1'b1);           // IF set
    check(10, irq === 1'b0);                          // masked by IEN=0
    reg_write(A_CTR, 8'hC0); #100;                    // IEN=1
    check(10, irq === 1'b1);                          // irq follows IF
    reg_write(A_CR, B_IACK); #100;
    check(10, irq === 1'b0);                          // IACK cleared IF
    reg_write(A_TXR, 8'h00);
    reg_write(A_CR, B_WR);
    wait_if(60, 10); #100;
    check(10, irq === 1'b1);                          // set again on completion
    reg_write(A_CR, B_IACK);
    reg_write(A_CR, B_STO);
    wait_if(60, 10);
    reg_write(A_CR, B_IACK);

    $display("PASS: all scenarios ok (%0d checks)", pass_cnt);
    $finish;
  end

  initial begin
    #10_000_000;                                      // 10 ms global watchdog
    $fatal(1, "global watchdog: simulation did not finish");
  end

endmodule
