// INTENTIONAL: module name does not match eda.yaml top (counter_top)
module tick_counter (
    input  wire       clk,
    input  wire       rst_n,
    output wire [7:0] count
);

    reg [7:0] cnt;
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            cnt <= 8'd0;
        else
            cnt <= cnt + 8'd1;
    end
    assign count = cnt;

endmodule
