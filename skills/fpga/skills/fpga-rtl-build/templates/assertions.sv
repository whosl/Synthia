// Bind or include in simulation/formal contexts only.
property p_stable_when_stalled;
    @(posedge clk) disable iff (!rst_n)
    s_valid && !s_ready |=> s_valid && $stable(s_data);
endproperty

assert property (p_stable_when_stalled)
    else $error("Stream payload changed while stalled");
