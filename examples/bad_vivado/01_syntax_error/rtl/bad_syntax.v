// INTENTIONAL: syntax errors for harness testing
module bad_syntax (
    input  wire       clk,
    input  wire       rst_n,
    output wire [7:0] led
);

    reg [7:0] count
    // ERROR: missing ';' above

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            count <= 8'd0;
        else
            count <= count + 1'b1
        // ERROR: missing ';' above
    end

    assign led = ;  // ERROR: empty expression

endmodule
