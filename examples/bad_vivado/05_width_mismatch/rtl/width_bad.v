// INTENTIONAL: width mismatch on assignment
module width_bad (
    input  wire       clk,
    input  wire       rst_n,
    input  wire [3:0] din,
    output wire [7:0] dout
);

    wire [7:0] wide_bus;

  // ERROR: 4-bit din into 8-bit wide_bus without extension
    assign wide_bus = din;

    reg [7:0] hold;
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            hold <= 8'd0;
        else
            hold <= wide_bus;
    end
    assign dout = hold;

endmodule
