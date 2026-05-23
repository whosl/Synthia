// uart_rx.v — UART Receiver (115200 baud, 8N1)
// 50 MHz clock, 87 cycles per bit @ 115200

module uart_rx #(
    parameter CLK_DIV = 87  // 50MHz / 115200 ≈ 434, oversample by 4
) (
    input  wire       clk,
    input  wire       rst_n,
    input  wire       rx,
    output reg  [7:0] data,
    output reg        valid
);

    localparam DIV_WIDTH = 10;

    // Synchronize rx to clk domain (2-stage)
    reg rx_sync1, rx_sync2;
    always @(posedge clk) begin
        rx_sync1 <= rx;
        rx_sync2 <= rx_sync1;
    end

    // State machine
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
            data     <= 0;
            valid    <= 0;
        end else begin
            valid <= 0;  // default: pulse for one cycle

            case (state)
                IDLE: begin
                    if (!rx_sync2) begin  // start bit detected
                        div_cnt <= 0;
                        state   <= START;
                    end
                end

                START: begin
                    if (div_cnt >= (CLK_DIV * 4) - 1) begin
                        div_cnt  <= 0;
                        state   <= DATA;
                        bit_cnt <= 0;
                    end else begin
                        div_cnt <= div_cnt + 1;
                    end
                end

                DATA: begin
                    if (div_cnt >= (CLK_DIV * 4) - 1) begin
                        div_cnt <= 0;
                        shift_reg[bit_cnt] <= rx_sync2;
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
                    if (div_cnt >= (CLK_DIV * 4) - 1) begin
                        div_cnt <= 0;
                        data    <= shift_reg;
                        valid   <= 1;
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
