// i2c_top — golden I2C master wrapper around the FreeCores `i2c` core
// (Wishbone revB.2 i2c_master_top with bit/byte controllers).
//
// This wrapper owns the I2C-DOC-001 processor-side contract; the reference
// core is instantiated verbatim (defines inlined only — the toolchain does
// not accept `include files):
//
//   register bus : psel/penable/pwrite/paddr[2:0]/pwdata/prdata, pready=1
//                  (zero-wait). Reads return the reference's registered
//                  data-out mux; CTR/SR are masked to the master-scope bit
//                  set (EN/IEN; RXACK/BUSY/AL/TIP/IF), debug addresses
//                  0x05-0x07 read 0x00 per DRQ-FUN-001.
//   write commit : a write access is latched and committed through the
//                  reference's wishbone port on its acknowledge cycle (one
//                  clock later). Invisible at the bus contract level.
//   command gate : the reference loads CR only while EN=1 (matches
//                  DRQ-FUN-002 — writes during EN=0 start nothing).
//   serial pads  : scl/sda are open-drain inouts: driven low or released,
//                  never actively driven high (DRQ-IF-002).
//   reset        : sync active-high rst maps to wb_rst_i; the reference's
//                  async reset input is tied to its deasserted level.
//   slave mode   : out of benchmark scope — the reference's slave-mode
//                  extension (CTR bit5, SR bits 3/2) is masked out of the
//                  register interface and left otherwise unconnected.
`timescale 1ns / 1ps

module i2c_top (
    input  wire       clk,
    input  wire       rst,          // sync active-high
    // processor-side register bus (zero-wait)
    input  wire       psel,
    input  wire       penable,
    input  wire       pwrite,
    input  wire [2:0] paddr,
    input  wire [7:0] pwdata,
    output wire [7:0] prdata,
    output wire       pready,
    // I2C serial side (open-drain, external pull-up)
    inout  wire       scl,
    inout  wire       sda,
    output wire       irq
);

  // ------------------------------------------------------------------
  // write-access latch -> wishbone commit
  // ------------------------------------------------------------------
  reg       aw_pending;
  reg [2:0] aw_addr;
  reg [7:0] aw_data;

  wire access = psel & penable;

  always @(posedge clk)
    if (rst) begin
      aw_pending <= 1'b0;
    end
    else if (access & pwrite) begin
      aw_pending <= 1'b1;
      aw_addr    <= paddr;
      aw_data    <= pwdata;
    end
    else if (wb_ack_o) begin
      aw_pending <= 1'b0;
    end

  wire        wb_ack_o;
  wire [7:0]  wb_dat_o;

  wire        wb_cyc_i = aw_pending;
  wire        wb_stb_i = aw_pending & ~wb_ack_o;
  wire        wb_we_i  = aw_pending;
  wire [2:0]  wb_adr_i = aw_pending ? aw_addr : paddr;
  wire [7:0]  wb_dat_i = aw_data;

  // ------------------------------------------------------------------
  // reference core
  // ------------------------------------------------------------------
  wire scl_pad_i    = scl;
  wire sda_pad_i    = sda;
  wire scl_pad_o, scl_padoen_o, sda_pad_o, sda_padoen_o;

  i2c_master_top ref_core (
    .wb_clk_i   (clk),
    .wb_rst_i   (rst),
    .arst_i     (1'b1),          // ARST_LVL=1: tie to deasserted level
    .wb_adr_i   (wb_adr_i),
    .wb_dat_i   (wb_dat_i),
    .wb_dat_o   (wb_dat_o),
    .wb_we_i    (wb_we_i),
    .wb_stb_i   (wb_stb_i),
    .wb_cyc_i   (wb_cyc_i),
    .wb_ack_o   (wb_ack_o),
    .wb_inta_o  (irq),
    .scl_pad_i  (scl_pad_i),
    .scl_pad_o  (scl_pad_o),
    .scl_padoen_o (scl_padoen_o),
    .sda_pad_i  (sda_pad_i),
    .sda_pad_o  (sda_pad_o),
    .sda_padoen_o (sda_padoen_o)
  );

  // open-drain pads: drive low or release — never drive high
  assign scl = scl_padoen_o ? 1'bz : scl_pad_o;
  assign sda = sda_padoen_o ? 1'bz : sda_pad_o;

  // ------------------------------------------------------------------
  // read path masking (master-scope register contract)
  // ------------------------------------------------------------------
  reg [7:0] prdata_r;
  always @(*) begin
    case (paddr)
      3'd0, 3'd1: prdata_r = wb_dat_o;                       // PRER
      3'd2:       prdata_r = wb_dat_o & 8'hC0;               // CTR: EN/IEN
      3'd3:       prdata_r = wb_dat_o;                       // RXR
      3'd4:       prdata_r = wb_dat_o & 8'hA3;               // SR: RXACK/BUSY/AL/TIP/IF
      default:    prdata_r = 8'h00;                          // 0x05-0x07
    endcase
  end
  assign prdata = prdata_r;
  assign pready = 1'b1;

endmodule
