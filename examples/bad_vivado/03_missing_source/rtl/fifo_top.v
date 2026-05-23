// INTENTIONAL: instantiates fifo_core which is missing from disk
module fifo_top (
    input  wire       clk,
    input  wire       rst_n,
    input  wire       push,
    input  wire [7:0] din,
    output wire       full,
    output wire [7:0] dout,
    output wire       empty
);

    fifo_core u_fifo (
        .clk   (clk),
        .rst_n (rst_n),
        .push  (push),
        .din   (din),
        .full  (full),
        .dout  (dout),
        .empty (empty)
    );

endmodule
