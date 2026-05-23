// Valid RTL — failure comes from test.mock_fail in MOCK mode
module blink_top (
    input  wire       clk,
    input  wire       rst_n,
    output wire       led
);

    reg [24:0] cnt;
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            cnt <= 25'd0;
        else
            cnt <= cnt + 25'd1;
    end
    assign led = cnt[24];

endmodule
