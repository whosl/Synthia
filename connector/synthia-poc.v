module synthia_probe(
  input wire clk,
  input wire a,
  input wire b,
  output reg y
);
  always @(posedge clk) y <= a ^ b;
endmodule
