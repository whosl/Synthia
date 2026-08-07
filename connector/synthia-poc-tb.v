`timescale 1ns/1ps
module synthia_probe_tb;
  reg clk = 0;
  reg a = 0;
  reg b = 0;
  wire y;
  synthia_probe dut(.clk(clk), .a(a), .b(b), .y(y));
  always #5 clk = ~clk;
  initial begin
    #12 a = 1;
    #10 b = 1;
    #10;
    if (y !== 0) $fatal(1, "unexpected y=%b", y);
    $display("SYNTHIA_XSIM_SUCCESS y=%b", y);
    $finish;
  end
endmodule
