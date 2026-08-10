module pipeline_stage #(
    parameter int WIDTH = 32
) (
    input  logic             clk,
    input  logic             rst_n,
    input  logic [WIDTH-1:0] s_data,
    input  logic             s_valid,
    output logic             s_ready,
    output logic [WIDTH-1:0] m_data,
    output logic             m_valid,
    input  logic             m_ready
);

    logic [WIDTH-1:0] data_q;
    logic             valid_q;

    assign s_ready = !valid_q || m_ready;
    assign m_data  = data_q;
    assign m_valid = valid_q;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            data_q  <= '0;
            valid_q <= 1'b0;
        end else if (s_ready) begin
            data_q  <= s_data;
            valid_q <= s_valid;
        end
    end

endmodule
