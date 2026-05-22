// uart_tx.v — UART Transmitter (115200 baud, 8N1)

module uart_tx #(
    parameter CLK_DIV = 434  // 50MHz / 115200 ≈ 434
) (
    input  wire       clk,
    input  wire       rst_n,
    input  wire [7:0] data,
    input  wire       send,
    output reg        tx,
    output reg        busy
);

    localparam DIV_WIDTH = 10;

    localparam IDLE   = 2'd0;
    localparam START  = 2'd1;
    localparam DATA   = 2'd2;
    localparam STOP   = 2'd3;

    reg [1:0] state;
    reg [DIV_WIDTH-1:0] div_cnt;
    reg [2:0] bit_cnt;
    reg [7:0] shift_reg;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state    <= IDLE;
            div_cnt  <= 0;
            bit_cnt  <= 0;
            shift_reg <= 0;
            tx       <= 1;
            busy     <= 0;
        end else begin
            case (state)
                IDLE: begin
                    tx   <= 1;
                    busy <= 0;
                    if (send) begin
                        shift_reg <= data;
                        state     <= START;
                        busy      <= 1;
                        div_cnt   <= 0;
                    end
                end

                START: begin
                    tx <= 0;  // start bit
                    if (div_cnt >= CLK_DIV - 1) begin
                        div_cnt <= 0;
                        state   <= DATA;
                        bit_cnt <= 0;
                    end else begin
                        div_cnt <= div_cnt + 1;
                    end
                end

                DATA: begin
                    tx <= shift_reg[bit_cnt];
                    if (div_cnt >= CLK_DIV - 1) begin
                        div_cnt <= 0;
                        if (bit_cnt == 7) begin
                            state <= STOP;
                        end else begin
                            bit_cnt <= bit_cnt + 1;
                        end
                    end else begin
                        div_cnt <= div_cnt + 1;
                    end
                end

                STOP: begin
                    tx <= 1;  // stop bit
                    if (div_cnt >= CLK_DIV - 1) begin
                        div_cnt <= 0;
                        state   <= IDLE;
                    end else begin
                        div_cnt <= div_cnt + 1;
                    end
                end

                default: state <= IDLE;
            endcase
        end
    end

endmodule
