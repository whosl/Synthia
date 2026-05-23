module gpio_top (
    input  wire       clk,
    input  wire       rst_n,
    output wire [7:0] led
);

    reg [7:0] shift;
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            shift <= 8'h01;
        else
            shift <= {shift[6:0], shift[7]};
    end
    assign led = shift;

endmodule
