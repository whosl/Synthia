typedef enum logic [1:0] {
    ST_IDLE,
    ST_RUN,
    ST_DONE,
    ST_ERR
} state_e;

state_e state_q, state_d;

always_comb begin
    state_d = state_q;
    unique case (state_q)
        ST_IDLE: begin
            if (start) state_d = ST_RUN;
        end
        ST_RUN: begin
            if (error) state_d = ST_ERR;
            else if (done) state_d = ST_DONE;
        end
        ST_DONE: begin
            state_d = ST_IDLE;
        end
        ST_ERR: begin
            if (clear_error) state_d = ST_IDLE;
        end
        default: state_d = ST_IDLE;
    endcase
end

always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) state_q <= ST_IDLE;
    else        state_q <= state_d;
end
